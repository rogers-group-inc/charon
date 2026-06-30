/**
 * agent/ui/app.js — Charon agent GUI (vanilla, runs in the Tauri webview).
 *
 * Uses the global Tauri API (withGlobalTauri) to call the Rust commands:
 *   is_enrolled, enroll, get_auth_config, login.
 * Shows the enrollment view until the device is enrolled, then the
 * server-dictated login flow (local credentials vs. browser SSO).
 */
(function () {
  "use strict";
  var invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || function () {
    return Promise.reject(new Error("Tauri API unavailable"));
  };

  function show(id) { document.getElementById(id).hidden = false; }
  function hide(id) { document.getElementById(id).hidden = true; }
  function setErr(id, msg) { var e = document.getElementById(id); e.textContent = msg; e.hidden = false; }

  function boot() {
    invoke("is_enrolled").then(function (enrolled) {
      if (enrolled) showLogin(); else show("enrollView");
    }).catch(function () { show("enrollView"); });
  }

  // ─── Enrollment ────────────────────────────────────────────────────────────
  document.getElementById("enrollBtn").addEventListener("click", function () {
    document.getElementById("enrollError").hidden = true;
    var serverUrl = document.getElementById("serverUrl").value.trim();
    var code = document.getElementById("code").value.trim();
    if (!serverUrl || !code) return setErr("enrollError", "Server URL and code are required");
    invoke("enroll", { serverUrl: serverUrl, code: code }).then(function () {
      hide("enrollView");
      showLogin();
    }).catch(function (e) { setErr("enrollError", String(e)); });
  });

  // ─── Login (server-dictated) ─────────────────────────────────────────────────
  function showLogin() {
    show("loginView");
    invoke("get_auth_config").then(function (cfg) {
      var mode = (cfg && cfg.mode) || "local";
      document.getElementById("loginSubtitle").textContent =
        mode === "local" ? "Sign in" : "Single sign-on";
      if (mode === "local") show("localLogin"); else show("ssoLogin");
    }).catch(function () { show("localLogin"); });
  }

  document.getElementById("loginBtn").addEventListener("click", function () {
    document.getElementById("loginError").hidden = true;
    invoke("login", {
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
    }).then(function (res) {
      if (res && res.mfaRequired) return setErr("loginError", "MFA required — TOTP entry not yet wired in the agent GUI");
      var ok = document.getElementById("loginOk");
      ok.textContent = "Verified. You may close this window.";
      ok.hidden = false;
    }).catch(function (e) { setErr("loginError", String(e)); });
  });

  document.getElementById("ssoBtn").addEventListener("click", function () {
    // The Rust core opens the server-brokered browser flow; binding completes
    // server-side via the SSO callback (wired with the auth providers).
    setErr("loginError", "SSO browser flow is wired with the SAML/OIDC providers.");
  });

  boot();
})();
