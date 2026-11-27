//! Redrob Drive's tray icon.
//!
//! A small resident program next to the `redrob` binary. It shows whether this computer is
//! connected to Redrob Chat (the desk relay of the shared daemon), and offers what a person needs
//! without a window: open Redrob Chat, open the home folder that Drive shares, pause or resume the
//! connection, and close the icon. It reads the daemon the same way every Rust Redrob app does
//! (crates/engine-client: `~/.redrob/run/server.json`, Basic auth to 127.0.0.1) and polls
//! `GET /desk/status`; pause and resume are `POST /desk/enable`.
//!
//! `redrob drive setup` starts it and registers it to start at login; `redrob drive off` stops it.
//! Usage: `redrob-tray [--chat <url>]` (the Redrob Chat it opens; production by default).
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::Duration;

use redrob_engine_client as engine;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

/// How often the connection is checked.
const POLL: Duration = Duration::from_secs(5);
const DEFAULT_CHAT: &str = "https://chat.redrob.ai";
const ICON_PNG: &[u8] = include_bytes!("../assets/mark.png");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    /// Signed in, desk on, relay connected: the chat can use this computer.
    On,
    /// The person paused it (desk off).
    Paused,
    /// No daemon, not signed in, or the relay is not reachable.
    Offline,
}

enum UserEvent {
    Status(State),
    Tray(TrayIconEvent),
    Menu(MenuEvent),
}

struct Text {
    name: &'static str,
    on: &'static str,
    paused: &'static str,
    offline: &'static str,
    open_chat: &'static str,
    open_folder: &'static str,
    pause: &'static str,
    resume: &'static str,
    close: &'static str,
}

/// Korean when the system language is Korean, English otherwise (the only two product languages).
fn text() -> Text {
    let korean = sys_locale::get_locale().is_some_and(|l| l.to_lowercase().starts_with("ko"));
    if korean {
        Text {
            name: "레드롭 드라이브",
            on: "켜짐 · 레드롭 챗에 연결됨",
            paused: "잠시 멈춤",
            offline: "연결 안 됨",
            open_chat: "레드롭 챗 열기",
            open_folder: "연결된 폴더 열기",
            pause: "잠시 멈춤",
            resume: "다시 켜기",
            close: "트레이 닫기",
        }
    } else {
        Text {
            name: "Redrob Drive",
            on: "On · connected to Redrob Chat",
            paused: "Paused",
            offline: "Not connected",
            open_chat: "Open Redrob Chat",
            open_folder: "Open the shared folder",
            pause: "Pause",
            resume: "Turn back on",
            close: "Close the tray icon",
        }
    }
}

fn label(t: &Text, state: State) -> &'static str {
    match state {
        State::On => t.on,
        State::Paused => t.paused,
        State::Offline => t.offline,
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(4))).http_status_as_error(false).build().into()
}

fn desk_url(record: &engine::Record, path: &str) -> String {
    format!("{}{}", record.url.trim_end_matches('/'), path)
}

/// The connection right now, from the daemon's `GET /desk/status`.
fn status() -> State {
    let Some(record) = engine::current() else { return State::Offline };
    let response = agent().get(&desk_url(&record, "/desk/status")).header("Authorization", &engine::authorization(&record.secret)).call();
    let Ok(mut response) = response else { return State::Offline };
    if !response.status().is_success() {
        return State::Offline;
    }
    let Ok(body) = response.body_mut().read_to_string() else { return State::Offline };
    let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let flag = |key: &str| value.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false);
    if !flag("enabled") {
        State::Paused
    } else if flag("signedIn") && flag("connected") {
        State::On
    } else {
        State::Offline
    }
}

/// The `redrob` binary beside this one (both are installed into the same folder), else the
/// engine-client lookup.
fn redrob_bin() -> PathBuf {
    let name = if cfg!(windows) { "redrob.exe" } else { "redrob" };
    std::env::current_exe().ok().map(|p| p.with_file_name(name)).filter(|p| p.is_file()).unwrap_or_else(engine::redrob_bin)
}

/// Start the shared daemon when none is running (it is normally started at login already).
fn start_daemon() -> Option<engine::Record> {
    if let Some(record) = engine::current() {
        return Some(record);
    }
    let mut command = std::process::Command::new(redrob_bin());
    command.args(["service", "start", "--idle-exit", "0"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the engine is a console program; no console flashes from the tray.
        command.creation_flags(0x0800_0000);
    }
    command.spawn().ok()?;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(200));
        if let Some(record) = engine::current() {
            return Some(record);
        }
    }
    None
}

/// Pause (`false`) or resume (`true`) the connection: `POST /desk/enable`.
fn set_enabled(on: bool) {
    let record = if on { start_daemon() } else { engine::current() };
    let Some(record) = record else { return };
    let body = if on { r#"{"enabled":true}"# } else { r#"{"enabled":false}"# };
    let _ = agent()
        .post(&desk_url(&record, "/desk/enable"))
        .header("Authorization", &engine::authorization(&record.secret))
        .header("Content-Type", "application/json")
        .send(body);
}

/// The mark as RGBA, grayed out when the computer is not connected.
fn icon(gray: bool) -> Option<Icon> {
    let (width, height, pixels) = rgba(ICON_PNG)?;
    Icon::from_rgba(if gray { grayed(pixels) } else { pixels }, width, height).ok()
}

/// A PNG decoded to RGBA: width, height, pixels.
fn rgba(png_bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let pixels = &buf[..info.buffer_size()];
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => pixels.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => pixels.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => pixels.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    Some((info.width, info.height, rgba))
}

/// The offline look: gray and see-through.
fn grayed(mut rgba: Vec<u8>) -> Vec<u8> {
    for p in rgba.chunks_exact_mut(4) {
        let l = ((u32::from(p[0]) * 30 + u32::from(p[1]) * 59 + u32::from(p[2]) * 11) / 100) as u8;
        p[0] = l;
        p[1] = l;
        p[2] = l;
        p[3] = (u32::from(p[3]) * 55 / 100) as u8;
    }
    rgba
}

fn chat_url() -> String {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--chat"
            && let Some(url) = args.next()
            && (url.starts_with("https://") || url.starts_with("http://"))
        {
            return url;
        }
    }
    DEFAULT_CHAT.to_string()
}

fn pid_file() -> Option<PathBuf> {
    engine::run_dir().map(|d| d.join("tray.pid"))
}

/// Windows 11 puts a new tray icon in the hidden overflow (the ^), where nobody sees that Drive is
/// on. Explorer keeps one record per program under `HKCU\Control Panel\NotifyIconSettings`, written
/// some time after the icon first shows; its `IsPromoted` value puts the icon on the taskbar. This
/// waits for our record and promotes it once. A marker remembers that, so a person who hides the
/// icon later is not overruled.
#[cfg(windows)]
fn show_on_taskbar_once() {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};

    let Some(marker) = dirs::home_dir().map(|h| h.join(".redrob").join("desk").join("tray-shown")) else { return };
    if marker.exists() {
        return;
    }
    let Ok(me) = std::env::current_exe() else { return };
    let me = me.to_string_lossy().to_lowercase();
    // Up to ten minutes: Explorer writes the record late, sometimes only after a while.
    for _ in 0..120 {
        if let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Control Panel\NotifyIconSettings", KEY_READ) {
            let mut found = false;
            for name in root.enum_keys().flatten() {
                let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ | KEY_WRITE) else { continue };
                let path: String = key.get_value("ExecutablePath").unwrap_or_default();
                let ours = if path.is_empty() {
                    // Explorer sometimes keeps only the picture of the icon, without the program's path.
                    key.get_raw_value("IconSnapshot").is_ok_and(|v| is_our_snapshot(&v.bytes))
                } else {
                    same_program(&path, &me)
                };
                if ours {
                    let _ = key.set_value("IsPromoted", &1u32);
                    found = true;
                }
            }
            if found {
                if let Some(dir) = marker.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&marker, "");
                return;
            }
        }
        std::thread::sleep(POLL);
    }
}

/// Explorer writes a path either in full or as `{known folder id}\rest`; the rest must end our path.
#[cfg(any(windows, test))]
fn same_program(path: &str, me: &str) -> bool {
    let path = path.to_lowercase();
    if path == me {
        return true;
    }
    match path.strip_prefix('{').and_then(|p| p.split_once("}\\")) {
        Some((_, rest)) => me.ends_with(&format!("\\{rest}")),
        None => false,
    }
}

/// Whether Explorer's saved picture of an icon (a 128 px PNG) is our mark, colored or grayed.
#[cfg(any(windows, test))]
fn is_our_snapshot(png_bytes: &[u8]) -> bool {
    let Some((w, h, snap)) = rgba(png_bytes) else { return false };
    let Some((mw, mh, mark)) = rgba(ICON_PNG) else { return false };
    w == mw && h == mh && [grayed(mark.clone()), mark].iter().any(|m| mean_difference(&snap, m) < 8.0)
}

/// Mean difference per channel, color weighted by alpha: a fully clear pixel's color says nothing.
#[cfg(any(windows, test))]
fn mean_difference(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return f64::MAX;
    }
    let pre = |p: &[u8]| {
        let alpha = u32::from(p[3]);
        [u32::from(p[0]) * alpha / 255, u32::from(p[1]) * alpha / 255, u32::from(p[2]) * alpha / 255, alpha]
    };
    let sum: u64 = a
        .chunks_exact(4)
        .zip(b.chunks_exact(4))
        .flat_map(|(x, y)| pre(x).into_iter().zip(pre(y)))
        .map(|(x, y)| u64::from(x.abs_diff(y)))
        .sum();
    sum as f64 / a.len() as f64
}

fn main() {
    // One icon per person: a second start (login item plus `drive setup`) just leaves.
    let instance = single_instance::SingleInstance::new("redrob-drive-tray").ok();
    if instance.as_ref().is_some_and(|i| !i.is_single()) {
        return;
    }
    if let Some(file) = pid_file() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, std::process::id().to_string());
    }

    let chat = chat_url();
    let t = text();
    #[cfg(windows)]
    std::thread::spawn(show_on_taskbar_once);

    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // A menu-bar item only: no Dock icon and no app menu.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    // Handlers may be called from another thread on some platforms: the proxy goes in a Mutex.
    let proxy = std::sync::Mutex::new(event_loop.create_proxy());
    TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
        if let Ok(proxy) = proxy.lock() {
            let _ = proxy.send_event(UserEvent::Tray(e));
        }
    }));
    let proxy = std::sync::Mutex::new(event_loop.create_proxy());
    MenuEvent::set_event_handler(Some(std::sync::Arc::new(move |e: MenuEvent| {
        if let Ok(proxy) = proxy.lock() {
            let _ = proxy.send_event(UserEvent::Menu(e));
        }
    })));
    let poller = event_loop.create_proxy();
    std::thread::spawn(move || {
        // The tray keeps the engine up: an update stops it, and a login start that could not be
        // registered never starts it. A paused Drive keeps its engine running (desk off), so this
        // never undoes a pause; `redrob drive off` closes the tray first.
        let mut last_start: Option<std::time::Instant> = None;
        loop {
            if engine::current().is_none() && last_start.is_none_or(|t| t.elapsed() >= Duration::from_secs(30)) {
                last_start = Some(std::time::Instant::now());
                let _ = start_daemon();
            }
            if poller.send_event(UserEvent::Status(status())).is_err() {
                return;
            }
            std::thread::sleep(POLL);
        }
    });
    let refresh = event_loop.create_proxy();

    let status_item = MenuItem::new(label(&t, State::Offline), false, None);
    let open_chat = MenuItem::new(t.open_chat, true, None);
    let open_folder = MenuItem::new(t.open_folder, true, None);
    let toggle = MenuItem::new(t.resume, true, None);
    let close = MenuItem::new(t.close, true, None);
    let menu = Menu::new();
    let _ = menu.append_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &open_chat,
        &open_folder,
        &toggle,
        &PredefinedMenuItem::separator(),
        &close,
    ]);

    let mut tray: Option<TrayIcon> = None;
    let mut menu = Some(menu);
    let mut state = State::Offline;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // The icon is made once the loop runs (macOS needs the app to be up first).
            Event::NewEvents(StartCause::Init) => {
                let mut builder = TrayIconBuilder::new()
                    .with_tooltip(format!("{} · {}", t.name, label(&t, state)))
                    // Windows and Linux: left click opens the chat, right click the menu.
                    // macOS: the menu on a click, as every menu-bar item does.
                    .with_menu_on_left_click(cfg!(target_os = "macos"));
                if let Some(menu) = menu.take() {
                    builder = builder.with_menu(Box::new(menu));
                }
                if let Some(icon) = icon(true) {
                    builder = builder.with_icon(icon);
                }
                tray = builder.build().ok();
            }
            Event::UserEvent(UserEvent::Status(next)) => {
                if next != state {
                    state = next;
                    if let Some(tray) = &tray {
                        let _ = tray.set_icon(icon(state != State::On));
                        let _ = tray.set_tooltip(Some(format!("{} · {}", t.name, label(&t, state))));
                    }
                    status_item.set_text(label(&t, state));
                    toggle.set_text(if state == State::On { t.pause } else { t.resume });
                }
            }
            Event::UserEvent(UserEvent::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            })) => {
                if !cfg!(target_os = "macos") {
                    let _ = open::that_detached(&chat);
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                if &event.id == open_chat.id() {
                    let _ = open::that_detached(&chat);
                } else if &event.id == open_folder.id() {
                    if let Some(home) = dirs::home_dir() {
                        let _ = open::that_detached(home);
                    }
                } else if &event.id == toggle.id() {
                    let on = state != State::On;
                    let refresh = refresh.clone();
                    std::thread::spawn(move || {
                        set_enabled(on);
                        let _ = refresh.send_event(UserEvent::Status(status()));
                    });
                } else if &event.id == close.id() {
                    if let Some(file) = pid_file() {
                        let _ = std::fs::remove_file(file);
                    }
                    tray = None;
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture Explorer saved for this icon on a real Windows 11 PC (the offline look).
    const SNAPSHOT: &[u8] = include_bytes!("../assets/test/snapshot.png");

    #[test]
    fn knows_its_own_snapshot() {
        assert!(is_our_snapshot(SNAPSHOT));
    }

    #[test]
    fn other_pictures_are_not_ours() {
        let (w, h, _) = rgba(ICON_PNG).unwrap();
        let mut other = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut other, w, h);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![200u8; (w * h * 4) as usize]).unwrap();
        }
        assert!(!is_our_snapshot(&other));
        assert!(!is_our_snapshot(b"not a png"));
    }

    #[test]
    fn known_folder_paths_match() {
        let me = r"c:\users\a\appdata\local\redrob\bin\redrob-tray.exe";
        assert!(same_program(r"C:\Users\A\AppData\Local\redrob\bin\redrob-tray.exe", me));
        assert!(same_program(r"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\redrob\bin\redrob-tray.exe", me));
        assert!(!same_program(r"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\other\redrob-tray.exe", me));
        assert!(!same_program(r"C:\Users\A\Downloads\redrob-tray.exe", me));
    }
}
