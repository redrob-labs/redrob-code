//! The popup a click on the tray icon opens (Windows and macOS): who is signed in and whether the
//! computer is connected, the usual folders to open, what Redrob did with this computer's files
//! lately, and the way to the chat or to pause. The page is `assets/popup.html` in the system web
//! view (wry); this side gives it the facts (`render(...)`) and does what its buttons ask
//! (`window.ipc.postMessage`: `chat`, `toggle`, `folder:<n>`).
//!
//! What Redrob did comes from the daemon's `~/.redrob/desk/events.jsonl`: one `{"type":"file"}`
//! line per folder looked in or file read, saved, moved or deleted from Redrob Chat (forward.ts).

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder};
use wry::{WebView, WebViewBuilder};

const HTML: &str = include_str!("../assets/popup.html");
const WIDTH: f64 = 372.0;
const HEIGHT: f64 = 470.0;
/// How far back in events.jsonl to look for the latest file events.
const EVENTS_TAIL_BYTES: u64 = 64 * 1024;
const RECENT: usize = 3;

/// What the page shows, as `render(...)` takes it.
pub struct Facts<'a> {
    pub state: &'a str,
    pub email: Option<&'a str>,
}

/// The four usual folders, in the order the page draws them: `(key, path)`.
pub fn folders() -> Vec<(&'static str, PathBuf)> {
    [("desktop", dirs::desktop_dir()), ("documents", dirs::document_dir()), ("downloads", dirs::download_dir()), ("pictures", dirs::picture_dir())]
        .into_iter()
        .filter_map(|(key, dir)| dir.filter(|d| d.is_dir()).map(|d| (key, d)))
        .collect()
}

/// The latest file events, newest first, as the JSON objects the daemon wrote.
fn recent() -> Vec<serde_json::Value> {
    let Some(file) = dirs::home_dir().map(|h| h.join(".redrob").join("desk").join("events.jsonl")) else { return Vec::new() };
    let Ok(mut f) = std::fs::File::open(file) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(EVENTS_TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    // A cut first line is not JSON and drops out on its own.
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|v| v.get("type").and_then(serde_json::Value::as_str) == Some("file"))
        .take(RECENT)
        .collect()
}

pub struct Popup {
    window: Window,
    webview: WebView,
    hidden_at: Option<Instant>,
}

impl Popup {
    /// The popup, hidden. `on_message` gets what the page's buttons post.
    pub fn new<T>(target: &EventLoopWindowTarget<T>, korean: bool, on_message: impl Fn(String) + 'static) -> Option<Self> {
        let builder = WindowBuilder::new()
            .with_title(if korean { "레드롭 드라이브" } else { "Redrob Drive" })
            .with_inner_size(LogicalSize::new(WIDTH, HEIGHT))
            .with_resizable(false)
            .with_decorations(false)
            .with_always_on_top(true)
            .with_visible(false);
        #[cfg(windows)]
        let builder = {
            use tao::platform::windows::WindowBuilderExtWindows;
            // The shadow keeps Windows 11's frame, which also rounds the corners.
            builder.with_skip_taskbar(true).with_undecorated_shadow(true)
        };
        let window = builder.build(target).ok()?;
        let lang = if korean { "ko" } else { "en" };
        let webview = WebViewBuilder::new()
            .with_html(HTML.replace("__LANG__", lang))
            .with_ipc_handler(move |request| on_message(request.body().clone()))
            .build(&window)
            .ok()?;
        Some(Self { window, webview, hidden_at: None })
    }

    pub fn visible(&self) -> bool {
        self.window.is_visible()
    }

    pub fn hide(&mut self) {
        if self.window.is_visible() {
            self.window.set_visible(false);
            self.hidden_at = Some(Instant::now());
        }
    }

    /// A click on the icon: show the popup beside it, or close it when it is open. A click that
    /// itself took the focus away (and so just closed it) does not open it again.
    pub fn toggle(&mut self, icon: tray_icon::Rect, facts: &Facts) {
        if self.window.is_visible() {
            self.hide();
            return;
        }
        if self.hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
            return;
        }
        self.place(icon);
        self.render(facts);
        self.window.set_visible(true);
        self.window.set_focus();
    }

    /// Next to the icon: above a bottom taskbar, below a top menu bar, inside the screen.
    fn place(&self, icon: tray_icon::Rect) {
        let scale = self.window.scale_factor();
        let (w, h) = (WIDTH * scale, HEIGHT * scale);
        let gap = 8.0 * scale;
        let (ix, iy) = (icon.position.x, icon.position.y);
        let (iw, ih) = (f64::from(icon.size.width), f64::from(icon.size.height));
        let monitor = self.window.current_monitor().or_else(|| self.window.primary_monitor());
        let (mx, my, mw, mh) = monitor.map_or((0.0, 0.0, 1920.0 * scale, 1080.0 * scale), |m| {
            (f64::from(m.position().x), f64::from(m.position().y), f64::from(m.size().width), f64::from(m.size().height))
        });
        let x = (ix + iw / 2.0 - w / 2.0).clamp(mx + gap, (mx + mw - w - gap).max(mx + gap));
        let below = iy - my < mh / 2.0;
        let y = if below { iy + ih + gap } else { iy - h - gap };
        self.window.set_outer_position(PhysicalPosition::new(x, y.max(my)));
    }

    /// Hand the page the current facts and the latest file events.
    pub fn render(&self, facts: &Facts) {
        let folders: Vec<_> = folders().into_iter().map(|(key, _)| key).collect();
        let data = serde_json::json!({
            "state": facts.state,
            "email": facts.email,
            "folders": folders,
            "recent": recent(),
        });
        let _ = self.webview.evaluate_script(&format!("render({data})"));
    }

    pub fn is(&self, id: tao::window::WindowId) -> bool {
        self.window.id() == id
    }
}
