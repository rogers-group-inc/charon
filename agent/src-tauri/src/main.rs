// Charon endpoint agent — Tauri (Rust core + web GUI).
//
// Lifecycle:
//   1. First launch: the GUI collects the server URL + a one-time invitation
//      code → enroll() swaps it for a long-lived bearer + the server leaf-cert
//      pin (stored in AgentConfig). The agent trusts ONLY that pin thereafter.
//   2. The GUI then asks the server which login mode to render
//      (get_auth_config → local | saml | oidc) and shows the matching flow.
//   3. A background loop sends heartbeat + posture every interval over the
//      pinned client. (A telemetry WebSocket is the production transport; the
//      polling loop is the always-available fallback used here.)
//
// All network calls go through the pinned client (client.rs). The bundled
// installers (MSI/pkg/AppImage) are produced in CI, not by the server.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod client;
mod config;
mod posture;

use config::AgentConfig;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

struct AppState {
    cfg: Mutex<AgentConfig>,
}

#[derive(Serialize)]
struct EnrollResponse {
    #[serde(rename = "endpointId")]
    endpoint_id: String,
    #[serde(rename = "bearerToken")]
    bearer_token: String,
    #[serde(rename = "serverCertPins")]
    server_cert_pins: Vec<String>,
}

/// Enroll with an invitation code. On success, persists the bearer + pins.
#[tauri::command]
async fn enroll(server_url: String, code: String, state: State<'_, AppState>) -> Result<(), String> {
    let hostname = hostname();
    // First contact uses the unpinned client (no pins yet); the response
    // carries the pins we persist and pin from here on.
    let http = client::pinned_client(&[]).map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "code": code,
        "hostname": hostname,
        "osPlatform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "agentVersion": env!("CARGO_PKG_VERSION"),
    });
    let resp = http
        .post(format!("{}/api/v1/agents/enroll", server_url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Enrollment failed: HTTP {}", resp.status()));
    }
    let parsed: EnrollResponse = resp.json().await.map_err(|e| e.to_string())?;

    let mut cfg = state.cfg.lock().unwrap();
    cfg.server_url = server_url.trim_end_matches('/').to_string();
    cfg.bearer = parsed.bearer_token;
    cfg.endpoint_id = parsed.endpoint_id;
    cfg.cert_pins = parsed.server_cert_pins;
    cfg.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Ask the server which login mode to render (drives the GUI).
#[tauri::command]
async fn get_auth_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (url, pins) = {
        let cfg = state.cfg.lock().unwrap();
        (cfg.server_url.clone(), cfg.cert_pins.clone())
    };
    if url.is_empty() {
        return Err("Not enrolled".into());
    }
    let http = client::pinned_client(&pins).map_err(|e| e.to_string())?;
    let resp = http
        .get(format!("{}/api/v1/agent/auth-config", url))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Local-mode user login → server binds {user ↔ device ↔ IP}.
#[tauri::command]
async fn login(username: String, password: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (url, pins, bearer) = snapshot(&state);
    let http = client::pinned_client(&pins).map_err(|e| e.to_string())?;
    let resp = http
        .post(format!("{}/api/v1/agents/login", url))
        .bearer_auth(bearer)
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Login failed: HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn is_enrolled(state: State<'_, AppState>) -> bool {
    state.cfg.lock().unwrap().is_enrolled()
}

fn snapshot(state: &State<'_, AppState>) -> (String, Vec<String>, String) {
    let cfg = state.cfg.lock().unwrap();
    (cfg.server_url.clone(), cfg.cert_pins.clone(), cfg.bearer.clone())
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

/// Background telemetry loop — heartbeat + posture every 60s once enrolled.
async fn telemetry_loop(cfg: AgentConfig) {
    if !cfg.is_enrolled() {
        return;
    }
    let http = match client::pinned_client(&cfg.cert_pins) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        let p = posture::collect();
        let _ = http
            .post(format!("{}/api/v1/agents/posture", cfg.server_url))
            .bearer_auth(&cfg.bearer)
            .json(&serde_json::json!({ "posture": p }))
            .send()
            .await;
        let _ = http
            .post(format!("{}/api/v1/agents/heartbeat", cfg.server_url))
            .bearer_auth(&cfg.bearer)
            .json(&serde_json::json!({ "hostname": hostname() }))
            .send()
            .await;
    }
}

fn main() {
    let cfg = AgentConfig::load();
    let loop_cfg = cfg.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState { cfg: Mutex::new(cfg) })
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                telemetry_loop(loop_cfg).await;
            });
            let _ = handle;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![enroll, get_auth_config, login, is_enrolled])
        .run(tauri::generate_context!())
        .expect("error while running Charon agent");
}
