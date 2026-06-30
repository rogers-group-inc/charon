//! Agent persistent configuration.
//!
//! Stored under the OS config dir (e.g. %APPDATA%\charon-agent on Windows).
//! Holds the server URL, the long-lived bearer issued at enrollment, and the
//! pinned server leaf-cert SHA-256 fingerprint(s). The bearer + pins are the
//! agent's entire trust anchor — it does NOT trust system roots.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Base URL of the Charon server, e.g. https://charon.example.com
    pub server_url: String,
    /// Long-lived bearer issued at enrollment (charon_…). Empty until enrolled.
    pub bearer: String,
    /// Endpoint id assigned by the server at enrollment.
    pub endpoint_id: String,
    /// Server leaf-cert SHA-256 pins (lowercase hex). canonical first, then
    /// staged pins accepted during a cert rotation.
    pub cert_pins: Vec<String>,
}

impl AgentConfig {
    pub fn is_enrolled(&self) -> bool {
        !self.bearer.is_empty() && !self.server_url.is_empty()
    }

    fn path() -> PathBuf {
        let dir = directories::ProjectDirs::from("com", "rogersgroup", "charon-agent")
            .map(|d| d.config_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let _ = fs::create_dir_all(&dir);
        dir.join("agent.json")
    }

    pub fn load() -> Self {
        match fs::read_to_string(Self::path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), std::io::Error> {
        let s = serde_json::to_string_pretty(self).unwrap_or_default();
        fs::write(Self::path(), s)
    }
}
