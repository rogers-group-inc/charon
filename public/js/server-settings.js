/**
 * public/js/server-settings.js — Server Settings (Certificates / Auth / HA).
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      wireTabs();
      loadCerts();
      loadAuth();
      document.getElementById("certUpload").addEventListener("click", uploadCert);
      document.getElementById("certStage").addEventListener("click", stagePin);
      document.getElementById("authSave").addEventListener("click", saveAuth);
    });
  });

  function wireTabs() {
    var tabs = document.querySelectorAll("#tabs .tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        document.querySelectorAll(".tab-panel").forEach(function (p) { p.hidden = true; });
        document.getElementById("panel-" + t.getAttribute("data-tab")).hidden = false;
        if (t.getAttribute("data-tab") === "ha") loadHa();
      });
    });
  }

  function loadCerts() {
    window.api.get("/server-settings/certificates").then(function (d) {
      var el = document.getElementById("certCurrent");
      if (!d.current) { el.innerHTML = '<p>No certificate uploaded yet.</p>'; return; }
      var c = d.current;
      el.innerHTML =
        "<p><strong>Subject:</strong> " + window.Charon.escapeHtml(c.subject) + "</p>" +
        "<p><strong>Valid:</strong> " + window.Charon.escapeHtml(c.validFrom) + " → " + window.Charon.escapeHtml(c.validTo) + "</p>" +
        "<p><strong>Agent pin (SHA-256):</strong><br><code>" + window.Charon.escapeHtml(c.sha256Display) + "</code></p>" +
        (d.pins && d.pins.staged && d.pins.staged.length ? "<p><strong>Staged pins:</strong> " + d.pins.staged.length + "</p>" : "");
    }).catch(function () {});
  }

  function uploadCert() {
    var err = document.getElementById("certError"), ok = document.getElementById("certOk");
    err.hidden = true; ok.hidden = true;
    window.api.post("/server-settings/certificates", {
      serverName: document.getElementById("serverName").value,
      certPem: document.getElementById("certPem").value,
      keyPem: document.getElementById("keyPem").value,
    }).then(function (r) {
      ok.textContent = "Uploaded. Agent pin: " + r.agentPin + ". nginx: " + r.nginx.message;
      ok.hidden = false;
      loadCerts();
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
  }

  function stagePin() {
    var err = document.getElementById("certError"), ok = document.getElementById("certOk");
    err.hidden = true; ok.hidden = true;
    var certPem = document.getElementById("certPem").value;
    if (!certPem) { err.textContent = "Paste the new certificate PEM to stage its pin."; err.hidden = false; return; }
    window.api.post("/server-settings/certificates/stage", { certPem: certPem }).then(function (r) {
      ok.textContent = "Staged pin " + r.stagedPin + " — agents now accept old+new. Swap the cert, then promote.";
      ok.hidden = false;
      loadCerts();
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
  }

  function loadAuth() {
    window.api.get("/server-settings/auth-mode").then(function (d) {
      document.getElementById("authMode").value = d.mode;
    }).catch(function () {});
  }

  function saveAuth() {
    window.api.put("/server-settings/auth-mode", { mode: document.getElementById("authMode").value })
      .then(function () { window.Charon.toast("Auth mode saved", "success"); })
      .catch(function (e) { window.Charon.toast(e.message, "error"); });
  }

  function loadHa() {
    window.api.get("/server-settings/ha").then(function (d) {
      var el = document.getElementById("haStatus");
      var rep = (d.replication || []).map(function (r) {
        return "<li>" + window.Charon.escapeHtml(r.client || "?") + " — " + r.state + " / " + r.sync_state + " (lag " + (r.lag_bytes || 0) + " bytes)</li>";
      }).join("");
      el.innerHTML =
        "<p><strong>This node:</strong> " + (d.isLeader ? '<span class="badge badge-info">LEADER</span>' : '<span class="badge">standby/follower</span>') + "</p>" +
        "<p><strong>Public URL:</strong> " + window.Charon.escapeHtml(d.publicUrl || "—") + "</p>" +
        "<p><strong>Replicas streaming:</strong></p>" + (rep ? "<ul>" + rep + "</ul>" : '<p class="muted">none reported (standby, or no replication configured)</p>');
    }).catch(function () {});
  }
})();
