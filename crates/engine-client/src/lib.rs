//! The shared Redrob Code daemon, from a Rust app.
//!
//! One `redrob serve --register` runs per user and every Redrob app attaches to it (the engine's
//! `docs/LOCAL-ENGINE-API.md`, section 3). The daemon leaves its record at
//! `$HOME/.redrob/run/server.json` (mode 0600): url, port, pid, version and the Basic secret, drawn
//! fresh on every start. This crate reads that record, checks the daemon answers with it, lists who
//! is attached, starts one through `redrob service start --json` when none answers, and stops it.
//!
//! Nothing here reads the engine's configuration or its credentials: the daemon's record is the
//! only file touched, and the only process reached is the one it names.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// The record `redrob serve --register` writes, and `redrob service start --json` prints.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// Random per start; a different id means the daemon restarted.
    pub id: String,
    pub version: String,
    pub url: String,
    pub port: u16,
    pub pid: u32,
    /// The Basic password (username `redrob`). Never log it.
    pub secret: String,
}

impl std::fmt::Display for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (pid {}, v{})", self.url, self.pid, self.version)
    }
}

/// One app attached to the daemon.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub app: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(rename = "attachedAt")]
    pub attached_at: u64,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

/// `GET /api/clients`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clients {
    pub clients: Vec<Client>,
    #[serde(rename = "ttlMs")]
    pub ttl_ms: u64,
    /// How long nobody has been attached, in ms; absent while someone is.
    #[serde(rename = "idleForMs", default)]
    pub idle_for_ms: Option<u64>,
    /// The daemon exits after this long with nobody attached; absent when it stays up.
    #[serde(rename = "idleExitAfterMs", default)]
    pub idle_exit_after_ms: Option<u64>,
}

/// `$HOME/.redrob/run`, or `REDROB_RUN_DIR`.
pub fn run_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("REDROB_RUN_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(d));
    }
    dirs::home_dir().map(|h| h.join(".redrob").join("run"))
}

pub fn record_path() -> Option<PathBuf> {
    run_dir().map(|d| d.join("server.json"))
}

/// The record on disk, or `None` when there is none or it does not parse.
pub fn read_record() -> Option<Record> {
    read_record_at(&record_path()?)
}

pub fn read_record_at(path: &Path) -> Option<Record> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// The `Authorization` header value for the daemon.
pub fn authorization(secret: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("redrob:{secret}")))
}

/// Where the OpenAI-compatible route lives: `<url>/v1` (chat completions is `/v1/chat/completions`).
pub fn openai_base(record: &Record) -> String {
    format!("{}/v1", record.url.trim_end_matches('/'))
}

/// The request header that names the calling app on the shared daemon.
pub const APP_HEADER: &str = "x-redrob-app";
/// The request header that names the caller's own session on the shared daemon.
pub const SESSION_HEADER: &str = "x-redrob-session";

/// Headers an app puts on every `/v1/chat/completions` call: the daemon's `Authorization`, the app
/// name, and (when the app has one) its session id. The engine forwards the labels to the provider
/// under the names its own agent runner uses, so the Console groups both paths alike. One daemon
/// serves every app, so the app name must travel on the request -- the daemon's environment names
/// nobody.
pub fn app_headers(record: &Record, app: &str, session: Option<&str>) -> Vec<(&'static str, String)> {
    let mut headers = vec![("Authorization", authorization(&record.secret)), (APP_HEADER, app.to_string())];
    if let Some(session) = session.map(str::trim).filter(|s| !s.is_empty()) {
        headers.push((SESSION_HEADER, session.to_string()));
    }
    headers
}

/// Why an app has no engine to talk to, for the message it shows. There is deliberately no
/// "fall back to the provider directly" arm: two paths would mean the user cannot tell whether
/// masking applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    /// No `redrob` binary: not installed. Point at the launcher or the Code install.
    NotInstalled,
    /// Installed, but `redrob service start` did not yield a healthy daemon.
    StartFailed(String),
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unavailable::NotInstalled => write!(f, "Redrob Code is not installed; install it (the launcher does this) and try again"),
            Unavailable::StartFailed(reason) => write!(f, "the Redrob Code engine could not be started: {reason}"),
        }
    }
}

/// [`connect_or_start_as`] with the two failure kinds told apart, for apps that render them.
pub fn require_as(app: &str, idle_exit_minutes: u32) -> Result<Record, Unavailable> {
    if !installed() {
        return Err(Unavailable::NotInstalled);
    }
    connect_or_start_as(app, idle_exit_minutes).map_err(Unavailable::StartFailed)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).http_status_as_error(false).build().into()
}

fn get_json<T: for<'de> Deserialize<'de>>(record: &Record, path: &str) -> Result<T, String> {
    let url = format!("{}{}", record.url.trim_end_matches('/'), path);
    let mut response = agent().get(&url).header("Authorization", &authorization(&record.secret)).call().map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("{path} answered {status}"));
    }
    let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Whether the daemon the record names answers `/api/health` with the record's secret.
pub fn healthy(record: &Record) -> bool {
    #[derive(Deserialize)]
    struct Health {
        healthy: bool,
    }
    matches!(get_json::<Health>(record, "/api/health"), Ok(Health { healthy: true }))
}

/// Who is attached, and the idle policy.
pub fn clients(record: &Record) -> Result<Clients, String> {
    get_json(record, "/api/clients")
}

/// The daemon as it stands: the record, if its daemon answers.
pub fn current() -> Option<Record> {
    let record = read_record()?;
    healthy(&record).then_some(record)
}

/// Where the engine binary is, by the engine's own resolution order: `REDROB_CODE_BIN`,
/// `~/.redrob/bin/redrob`, then (Windows) the installer's folder `%LOCALAPPDATA%\Redrob\bin`, then
/// `redrob` on PATH. The Windows installers (the setup.exe and the MSI) put the engine in that
/// LOCALAPPDATA folder and append it to the user's PATH; a process started before the install
/// still has the old PATH, so the folder is tried by name.
pub fn redrob_bin() -> PathBuf {
    if let Some(b) = std::env::var_os("REDROB_CODE_BIN").filter(|v| !v.is_empty()) {
        return PathBuf::from(b);
    }
    let name = if cfg!(windows) { "redrob.exe" } else { "redrob" };
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".redrob").join("bin").join(name);
        if p.is_file() {
            return p;
        }
    }
    if cfg!(windows)
        && let Some(local) = dirs::data_local_dir()
    {
        let p = local.join("Redrob").join("bin").join(name);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("redrob")
}

/// Whether an engine binary can be found at all.
pub fn installed() -> bool {
    let bin = redrob_bin();
    if bin.components().count() > 1 {
        return bin.is_file();
    }
    // Bare name: look along PATH.
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|d| {
        let p = d.join(&bin);
        p.is_file() || (cfg!(windows) && d.join(format!("{}.exe", bin.display())).is_file())
    })
}

/// Pulls the one JSON line out of what `redrob service start --json` printed.
pub fn parse_record_output(stdout: &str) -> Result<Record, String> {
    let line = stdout.lines().map(str::trim).rfind(|l| l.starts_with('{')).ok_or("the engine printed no daemon record")?;
    serde_json::from_str(line).map_err(|e| format!("the engine printed a record that does not parse: {e}"))
}

/// Find the daemon or start it: `redrob service start --json`, which holds the start and upgrade
/// logic in one place (the engine). `idle_exit_minutes`: how long a daemon started here stays up
/// with nobody attached; `0` keeps it up. The daemon is started under the launcher's name; an app
/// that wants its own name on the start uses [`connect_or_start_as`].
pub fn connect_or_start(idle_exit_minutes: u32) -> Result<Record, String> {
    connect_or_start_as("launcher", idle_exit_minutes)
}

/// [`connect_or_start`], naming the app that asked (`REDROB_APP` on the `redrob service start`
/// call; the daemon itself serves every app, so per-request labels go on the request as
/// `x-redrob-app`, see [`app_headers`]).
pub fn connect_or_start_as(app: &str, idle_exit_minutes: u32) -> Result<Record, String> {
    if let Some(record) = current() {
        return Ok(record);
    }
    let bin = redrob_bin();
    let output = Command::new(&bin)
        .args(["service", "start", "--json", "--idle-exit", &idle_exit_minutes.to_string()])
        .env("REDROB_APP", app)
        .output()
        .map_err(|e| format!("could not run {}: {e}. Install Redrob Code first.", bin.display()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        return Err(format!("redrob service start failed ({}): {}", output.status, if err.trim().is_empty() { out.trim() } else { err.trim() }));
    }
    parse_record_output(&String::from_utf8_lossy(&output.stdout))
}

/// Stop the daemon the record names: `redrob service stop`, which signals only a daemon that
/// answered with the record's own secret, so a stale pid another process now owns is never hit.
pub fn stop() -> Result<bool, String> {
    if read_record().is_none() {
        return Ok(false);
    }
    let bin = redrob_bin();
    let output = Command::new(&bin).args(["service", "stop"]).output().map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    if !output.status.success() {
        return Err(format!("redrob service stop failed ({})", output.status));
    }
    // The CLI prints its one word on stderr; what matters is that the record is gone.
    Ok(read_record().is_none())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        Record { id: "id".into(), version: "0.6.0".into(), url: "http://127.0.0.1:4096".into(), port: 4096, pid: 1, secret: "s3cret".into() }
    }

    #[test]
    fn the_record_round_trips_and_reads_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.json");
        std::fs::write(&path, serde_json::to_string(&record()).unwrap()).unwrap();
        assert_eq!(read_record_at(&path), Some(record()));
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(read_record_at(&path), None);
        std::fs::write(&path, r#"{"url":"x","pid":1}"#).unwrap();
        assert_eq!(read_record_at(&path), None, "a record missing fields is not a record");
    }

    #[test]
    fn the_basic_header_names_the_daemon_user() {
        let header = authorization("abc");
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        assert_eq!(decoded, b"redrob:abc");
    }

    #[test]
    fn the_openai_base_is_v1_under_the_daemon_url() {
        assert_eq!(openai_base(&record()), "http://127.0.0.1:4096/v1");
        assert_eq!(openai_base(&Record { url: "http://127.0.0.1:4096///".into(), ..record() }), "http://127.0.0.1:4096/v1");
    }

    #[test]
    fn the_last_json_line_of_service_start_is_the_record() {
        let out = format!("some warning\n{}\n", serde_json::to_string(&record()).unwrap());
        assert_eq!(parse_record_output(&out).unwrap(), record());
        assert!(parse_record_output("nothing here").is_err());
    }

    #[test]
    fn clients_parse_with_the_optional_fields_absent_or_present() {
        let c: Clients = serde_json::from_str(r#"{"clients":[],"ttlMs":90000,"idleForMs":12}"#).unwrap();
        assert_eq!(c.idle_for_ms, Some(12));
        assert_eq!(c.idle_exit_after_ms, None);
        let c: Clients =
            serde_json::from_str(r#"{"clients":[{"id":"a","app":"design","attachedAt":1,"lastSeen":2}],"ttlMs":90000,"idleExitAfterMs":600000}"#)
                .unwrap();
        assert_eq!(c.clients[0].app, "design");
        assert_eq!(c.clients[0].pid, None);
        assert_eq!(c.idle_exit_after_ms, Some(600_000));
    }

    #[test]
    fn a_daemon_that_does_not_answer_is_not_healthy() {
        assert!(!healthy(&Record { url: "http://127.0.0.1:9".into(), ..record() }));
    }

    #[test]
    fn app_headers_carry_auth_app_and_an_optional_session() {
        let h = app_headers(&record(), "shape", None);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].0, "Authorization");
        assert_eq!(h[0].1, authorization("s3cret"));
        assert_eq!(h[1], (APP_HEADER, "shape".to_string()));
        let h = app_headers(&record(), "shape", Some(" doc-42 "));
        assert_eq!(h[2], (SESSION_HEADER, "doc-42".to_string()));
        assert_eq!(app_headers(&record(), "shape", Some("  ")).len(), 2, "a blank session sends nothing");
    }

    #[test]
    fn unavailable_tells_not_installed_from_a_start_failure() {
        assert!(Unavailable::NotInstalled.to_string().contains("not installed"));
        assert!(Unavailable::StartFailed("boom".into()).to_string().ends_with("boom"));
        assert_ne!(Unavailable::NotInstalled, Unavailable::StartFailed(String::new()));
    }
}
