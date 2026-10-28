//! Push-deploy enrollment preseed.
//!
//! A push deployment (server: src/services/agentInstallScripts.ts) drops a small
//! JSON file next to the installed agent: the server URL, the server's leaf-cert
//! pins and a single-use, 10-minute invitation code. The file is readable by
//! root / SYSTEM + Administrators only (Charon business rule 12), so only a
//! privileged agent process can consume it — the background-service mode.
//!
//! On startup, an un-enrolled agent that can read it enrolls PINNED FROM THE
//! FIRST REQUEST (never the system roots), reports the leaf fingerprint it
//! observed, persists the bearer + pins, and deletes the file.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct Preseed {
    pub version: u32,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    pub pins: Vec<String>,
    pub code: String,
}

/// Where the install scripts write it (agentInstallScripts.ts → PRESEED_PATHS).
pub fn path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(base).join("Charon").join("agent").join("enroll.json")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/Charon/enroll.json")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/etc/charon-agent/enroll.json")
    }
}

fn is_pin(p: &str) -> bool {
    p.len() == 64 && p.chars().all(|c| c.is_ascii_hexdigit())
}

/// Read and validate the preseed. None when absent, unreadable (an unprivileged
/// process), malformed, or carrying no usable pin — a preseed without a pin
/// must never fall back to the system roots.
pub fn load() -> Option<Preseed> {
    let raw = std::fs::read_to_string(path()).ok()?;
    let p: Preseed = serde_json::from_str(&raw).ok()?;
    if p.version != 1 || !p.server_url.starts_with("https://") || p.code.is_empty() {
        return None;
    }
    if p.pins.is_empty() || !p.pins.iter().all(|x| is_pin(x)) {
        return None;
    }
    Some(p)
}

/// Delete the preseed once it has been consumed (or proved useless).
pub fn remove() {
    let _ = std::fs::remove_file(path());
}
