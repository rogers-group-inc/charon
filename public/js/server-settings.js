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
        var tab = t.getAttribute("data-tab");
        if (tab === "ha") loadHa();
        if (tab === "maint") loadMaintenance();
      });
    });
  }

  // ─── Maintenance ─────────────────────────────────────────────────────────
  var maintWired = false, updatePoll = null;
  function loadMaintenance() {
    loadCapacity();
    loadBackups();
    loadUpdate();
    loadInstallers();
    if (!maintWired) {
      maintWired = true;
      document.getElementById("bkCreate").addEventListener("click", createBackup);
      document.getElementById("updateStart").addEventListener("click", startUpdate);
      document.getElementById("restartBtn").addEventListener("click", restart);
    }
  }

  function bar(v) {
    var pct = Math.round(v.usedRatio * 100);
    var color = v.severity === "critical" ? "var(--color-danger)" : v.severity === "warning" ? "var(--color-warning)" : "var(--color-accent)";
    return "<div style='margin:0.4rem 0'><div>" + window.Charon.escapeHtml(v.label) + " — " + pct + "% used</div>" +
      "<div style='background:var(--color-bg-tertiary);border-radius:4px;height:10px;overflow:hidden'><div style='width:" + pct + "%;height:100%;background:" + color + "'></div></div></div>";
  }
  function loadCapacity() {
    window.api.get("/server-settings/maintenance/capacity").then(function (c) {
      var html = c.volumes.map(bar).join("");
      if (c.databaseSizeBytes) html += "<p class='muted'>Database: " + (c.databaseSizeBytes / 1048576).toFixed(1) + " MiB</p>";
      if (c.advisor.length) html += "<ul>" + c.advisor.map(function (a) { return "<li>" + window.Charon.escapeHtml(a) + "</li>"; }).join("") + "</ul>";
      document.getElementById("capacity").innerHTML = html || "OK";
    }).catch(function (e) { document.getElementById("capacity").textContent = e.message; });
  }

  function loadBackups() {
    window.api.get("/server-settings/maintenance/backups").then(function (d) {
      var el = document.getElementById("backups");
      if (!d.backups.length) { el.innerHTML = "No backups yet."; return; }
      el.innerHTML = "<ul>" + d.backups.map(function (b) {
        return "<li>" + window.Charon.escapeHtml(b.filename) + " (" + (b.sizeBytes / 1024).toFixed(0) + " KiB" + (b.encrypted ? ", encrypted" : "") + ") " +
          '<button class="btn btn-sm" data-restore="' + window.Charon.escapeHtml(b.filename) + '">Restore</button></li>';
      }).join("") + "</ul>";
      el.querySelectorAll("[data-restore]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var fn = btn.getAttribute("data-restore");
          var pwd = fn.endsWith(".enc") ? prompt("Backup password:") : undefined;
          if (fn.endsWith(".enc") && !pwd) return;
          if (!confirm("Restore " + fn + "? This overwrites the current database.")) return;
          window.api.post("/server-settings/maintenance/backups/restore", { filename: fn, password: pwd || undefined })
            .then(function () { window.Charon.toast("Restore complete", "success"); })
            .catch(function (e) { window.Charon.toast(e.message, "error"); });
        });
      });
    }).catch(function () {});
  }

  function createBackup() {
    var pwd = document.getElementById("bkPass").value || undefined;
    window.Charon.toast("Creating backup…", "info");
    window.api.post("/server-settings/maintenance/backups", { password: pwd })
      .then(function (r) { window.Charon.toast("Backup created: " + r.backup.filename, "success"); loadBackups(); })
      .catch(function (e) { window.Charon.toast(e.message, "error"); });
  }

  function loadUpdate() {
    window.api.get("/server-settings/maintenance/update/check").then(function (d) {
      var info = "Current: " + d.current + ". ";
      if (!d.environment.canSelfUpdate) { info += d.environment.reason; document.getElementById("updateStart").disabled = true; }
      else { info += (d.behind == null ? "Update status unknown." : d.behind === 0 ? "Up to date." : d.behind + " commit(s) behind."); document.getElementById("updateStart").disabled = false; }
      document.getElementById("updateInfo").textContent = info;
    }).catch(function () {});
  }

  function startUpdate() {
    window.api.post("/server-settings/maintenance/update/start", {
      backupFirst: document.getElementById("bkBeforeUpdate").checked,
      confirmNode: document.getElementById("confirmNode").checked,
    }).then(function () {
      if (updatePoll) clearInterval(updatePoll);
      updatePoll = setInterval(pollUpdate, 2000);
    }).catch(function (e) { window.Charon.toast(e.message, "error"); });
  }

  function pollUpdate() {
    window.api.get("/server-settings/maintenance/update/status").then(function (s) {
      document.getElementById("updateProgress").textContent = "[" + s.step + "] " + s.message + (s.error ? " — " + s.error : "");
      if (s.step === "done" || s.step === "error") { clearInterval(updatePoll); updatePoll = null; }
    }).catch(function () { clearInterval(updatePoll); updatePoll = null; });
  }

  function loadInstallers() {
    window.api.get("/server-settings/maintenance/agents").then(function (d) {
      var el = document.getElementById("agentInstallers");
      if (!d.manifest) { el.textContent = "No agent installers published. CI drops them under data/agents/."; return; }
      el.innerHTML = "<p>Version " + window.Charon.escapeHtml(d.manifest.version) + "</p><ul>" +
        d.manifest.files.map(function (f) {
          return "<li>" + f.platform + "/" + f.arch + " — <a href='/api/v1/server-settings/maintenance/agents/download/" + encodeURIComponent(f.filename) + "'>" + window.Charon.escapeHtml(f.filename) + "</a></li>";
        }).join("") + "</ul>";
    }).catch(function () {});
  }

  function restart() {
    if (!confirm("Restart Charon now?")) return;
    window.api.post("/server-settings/maintenance/restart").then(function () { window.Charon.toast("Restart requested", "success"); }).catch(function (e) { window.Charon.toast(e.message, "error"); });
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
        "<p><strong>This node:</strong> " + (d.isLeader ? '<span class="badge badge-active">LEADER</span>' : '<span class="badge">standby/follower</span>') + "</p>" +
        "<p><strong>Public URL:</strong> " + window.Charon.escapeHtml(d.publicUrl || "—") + "</p>" +
        "<p><strong>Replicas streaming:</strong></p>" + (rep ? "<ul>" + rep + "</ul>" : '<p class="muted">none reported (standby, or no replication configured)</p>');
    }).catch(function () {});
  }
})();
