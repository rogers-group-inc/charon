//! Posture collectors.
//!
//! Gathers the device-health signals the server's posture policy evaluates:
//! disk encryption, host firewall, antivirus/EDR presence, OS version. Windows
//! is first-class (shells out to PowerShell/Get-* cmdlets); macOS/Linux have
//! best-effort collectors. Every field is optional — the server treats a
//! missing signal conservatively.

use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub struct Posture {
    #[serde(rename = "diskEncryption")]
    pub disk_encryption: Option<bool>,
    pub firewall: Option<bool>,
    pub antivirus: Option<bool>,
    #[serde(rename = "osVersion")]
    pub os_version: Option<String>,
}

pub fn collect() -> Posture {
    Posture {
        disk_encryption: disk_encryption(),
        firewall: firewall_enabled(),
        antivirus: antivirus_present(),
        os_version: os_version(),
    }
}

fn os_version() -> Option<String> {
    Some(std::env::consts::OS.to_string())
}

#[cfg(target_os = "windows")]
fn ps(cmd: &str) -> Option<String> {
    use std::process::Command;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", cmd])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn disk_encryption() -> Option<bool> {
    // BitLocker: any volume reporting FullyEncrypted.
    ps("(Get-BitLockerVolume | Where-Object { $_.VolumeStatus -eq 'FullyEncrypted' }).Count")
        .map(|s| s.parse::<i32>().map(|n| n > 0).unwrap_or(false))
}

#[cfg(target_os = "windows")]
fn firewall_enabled() -> Option<bool> {
    ps("(Get-NetFirewallProfile | Where-Object { $_.Enabled -eq 'True' }).Count")
        .map(|s| s.parse::<i32>().map(|n| n > 0).unwrap_or(false))
}

#[cfg(target_os = "windows")]
fn antivirus_present() -> Option<bool> {
    ps("(Get-MpComputerStatus).AntivirusEnabled").map(|s| s.eq_ignore_ascii_case("true"))
}

#[cfg(target_os = "macos")]
fn disk_encryption() -> Option<bool> {
    use std::process::Command;
    let out = Command::new("fdesetup").arg("status").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).contains("FileVault is On"))
}
#[cfg(target_os = "macos")]
fn firewall_enabled() -> Option<bool> {
    None // socketfilterfw requires elevated context; left to a privileged helper
}
#[cfg(target_os = "macos")]
fn antivirus_present() -> Option<bool> {
    None
}

#[cfg(target_os = "linux")]
fn disk_encryption() -> Option<bool> {
    use std::process::Command;
    let out = Command::new("lsblk").args(["-o", "TYPE"]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).contains("crypt"))
}
#[cfg(target_os = "linux")]
fn firewall_enabled() -> Option<bool> {
    None
}
#[cfg(target_os = "linux")]
fn antivirus_present() -> Option<bool> {
    None
}
