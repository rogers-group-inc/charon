/**
 * public/js/integrations.js — Integrations page.
 *
 * Ported from polaris's integrations UI, cut to Charon's four types:
 * FortiManager and FortiGate (enforcement targets — no discovery), Active
 * Directory and Microsoft Entra ID (directory sources; Intune is a flag on the
 * Entra integration, config.enableIntune). polaris's inventory and monitoring
 * features (DHCP / quarantine push, SD-WAN, description sync, geo, the class
 * monitor subtabs, auto-monitor, agent deploy, script publishing tabs other
 * than Intune's, directory search/sync) have no Charon counterpart and are gone.
 *
 * What is Charon's own and not polaris's: the per-integration enforcement
 * toggle (dry-run ↔ live writes, gated by the separate "enforcement" key) and
 * the sync-state (drift) view for the Fortinet pair.
 *
 * Shape:
 *   cards           one .integration-card per integration (status, details,
 *                   Discover for directory types, actions)
 *   the modal       polaris's openIntegrationModal shell: "<Action> <Product>
 *                   Integration", tabs, footer Test Connection · Cancel · Save.
 *                   One builder per type serves both Add and Edit.
 *   API consoles    READ-ONLY per-type query consoles (POST /:id/query) with a
 *                   localStorage saved-query list. No write methods and no
 *                   per-request token override (the server rejects both).
 *
 * The server masks secrets ("••••••••"); a secret field renders blank on Edit
 * and a blank submit keeps the stored value — unless host / port / TLS changed,
 * in which case the server answers 400 asking for the secret again, and that
 * message is surfaced as-is.
 */
(function () {
  "use strict";

  var MASK = "••••••••";

  // Product names — the modal title is "<Action> <Product> Integration".
  var PRODUCTS = {
    fortimanager: "FortiManager",
    fortigate: "FortiGate",
    entraid: "Microsoft Entra ID",
    activedirectory: "Active Directory",
  };
  // Short card badges.
  var BADGES = {
    fortimanager: "FortiManager",
    fortigate: "FortiGate",
    entraid: "Entra ID",
    activedirectory: "Active Directory",
  };
  // Type-picker subtitles, in picker order.
  var TYPE_ORDER = ["fortimanager", "fortigate", "entraid", "activedirectory"];
  var TYPE_DESC = {
    fortimanager: "Enforcement across managed FortiGates via JSON-RPC",
    fortigate: "Enforcement on a standalone FortiGate via REST",
    entraid: "Users, groups & devices via Microsoft Graph (+ Intune)",
    activedirectory: "Users, groups, computers & OUs via LDAP",
  };
  // Directory sources run discovery; the Fortinet pair are enforcement targets.
  var DIRECTORY_TYPES = { activedirectory: 1, entraid: 1 };
  var ENFORCE_TYPES = { fortimanager: 1, fortigate: 1 };

  var perms = { write: false, fullwrite: false, enforceRead: false, enforceWrite: false };
  var integrations = [];          // last GET /integrations
  var activeRuns = {};            // integrationId → discovery run (GET /discoveries)
  var pollTimer = null;

  function esc(s) { return window.Charon.escapeHtml(s == null ? "" : String(s)); }
  function toast(msg, kind) { window.Charon.toast(msg, kind); }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      perms.write = window.Charon.can("integrations", "write");
      perms.fullwrite = window.Charon.can("integrations", "fullwrite");
      // Must match the routes: PATCH /:id/enforcement is enforcement:fullwrite,
      // GET /:id/enforcement-state is enforcement:read.
      perms.enforceRead = window.Charon.can("enforcement", "read");
      perms.enforceWrite = window.Charon.can("enforcement", "fullwrite");
      var addBtn = document.getElementById("btn-add-integration");
      if (perms.write) {
        addBtn.style.display = "";
        addBtn.addEventListener("click", showTypePicker);
      }
      document.getElementById("integrations-list").addEventListener("click", onCardClick);
      loadIntegrations();
      loadHealthSummary();
      pollDiscoveries();
    });
  });

  // ─── UI parts (polaris app.js's shared form helpers, local here) ─────────────

  function sectionHeading(text) {
    return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;' +
      'color:var(--color-text-tertiary);margin-bottom:0.75rem">' + esc(text) + "</p>";
  }

  function formDivider() {
    return '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
  }

  function infoBox(html) {
    return '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);' +
      'border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);' +
      'border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;' +
      'color:var(--color-text-secondary);line-height:1.5">' + html + "</div>";
  }

  // `labelHtml` is trusted markup built in this file, never user input.
  function checkboxRow(id, labelHtml, on) {
    return '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + ' style="width:auto">' +
        '<label for="' + id + '" style="margin:0">' + labelHtml + "</label>" +
      "</div>";
  }

  var CALLOUT_VARIANTS = {
    warning: { color: "var(--color-warning)", icon: "&#9888;" },
    tip:     { color: "var(--color-accent)", icon: "&#128161;" },
    note:    { color: "var(--color-text-secondary)", icon: "" },
  };
  function calloutHTML(variant, title, bodyHtml) {
    var v = CALLOUT_VARIANTS[variant] || CALLOUT_VARIANTS.note;
    return '<div style="border-left:3px solid ' + v.color + ";" +
        "background:color-mix(in srgb, " + v.color + " 9%, transparent);" +
        'border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:0.6rem 0.8rem;margin:0.75rem 0">' +
        (title ? '<p style="margin:0 0 0.4rem 0;font-weight:600;color:' + v.color + '">' + (v.icon ? v.icon + " " : "") + title + "</p>" : "") +
        '<p class="hint" style="margin:0">' + bodyHtml + "</p>" +
      "</div>";
  }

  // The TLS-verify-off warning. Verification off is not "trust anything": the
  // server pins the leaf certificate on first use (TlsCertPin) and refuses a
  // changed one until an operator trusts it.
  function tlsOffHint(what) {
    return '<p class="hint" style="color:var(--color-warning)">Leave enabled. With verification off, Charon pins ' +
      what + "'s certificate on first use (trust-on-first-use) and refuses a changed certificate until it is " +
      "trusted under <strong>Server Settings &rarr; Web Server &rarr; Pinned server identities</strong>. " +
      "Disable only for a device with a self-signed certificate you cannot replace.</p>";
  }

  function hoursField(d, hint) {
    return '<div class="form-group"><label>Auto-Discovery Interval</label>' +
      '<div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' +
      (d.pollInterval || 4) + '" min="1" max="168" style="width:80px">' +
      '<span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div>' +
      '<p class="hint">' + hint + " (1–168 hours)</p></div>";
  }

  // Include / exclude pattern list: one <select> + one textarea, one array set.
  function filterBlock(modeId, namesId, include, exclude, what, placeholder, hint) {
    var mode = include && include.length ? "include" : "exclude";
    var list = mode === "include" ? include : (exclude || []);
    return '<div class="form-group">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
          '<select id="' + modeId + '" style="width:auto">' +
            '<option value="include"' + (mode === "include" ? " selected" : "") + ">Include</option>" +
            '<option value="exclude"' + (mode === "exclude" ? " selected" : "") + ">Exclude</option>" +
          "</select>" +
          '<span style="font-size:0.85rem;color:var(--color-text-secondary)">' + what + "</span>" +
        "</div>" +
        '<textarea id="' + namesId + '" rows="3" placeholder="' + placeholder + '">' + esc(list.join("\n")) + "</textarea>" +
        '<p class="hint">' + hint + "</p>" +
      "</div>";
  }

  function readFilter(modeId, namesId) {
    var el = document.getElementById(namesId);
    var names = el ? el.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var mode = val(modeId) === "include" ? "include" : "exclude";
    return { include: mode === "include" ? names : [], exclude: mode === "exclude" ? names : [] };
  }

  function secretInput(id, label, stored, placeholderNew, keepText, hint) {
    return '<div class="form-group"><label>' + label + '</label><input type="password" id="' + id +
      '" value="" autocomplete="new-password" placeholder="' + esc(stored ? keepText : placeholderNew) + '">' +
      (hint ? '<p class="hint">' + hint + "</p>" : "") + "</div>";
  }

  function isStored(v) { return typeof v === "string" && v.length > 0; }

  // ─── Tabs (polaris tabbedBodyHTML / wireModalTabs) ──────────────────────────

  function tabbedBodyHTML(prefix, tabs) {
    return '<div class="page-tabs" id="' + prefix + '-tabs" style="margin-bottom:1rem">' +
        tabs.map(function (t, i) {
          return '<button type="button" class="page-tab' + (i === 0 ? " active" : "") +
            '" data-tab="' + esc(t.key) + '">' + esc(t.label) + "</button>";
        }).join("") +
      "</div>" +
      tabs.map(function (t, i) {
        return '<div class="page-tab-panel' + (i === 0 ? " active" : "") +
          '" id="' + prefix + "-tab-" + esc(t.key) + '">' + t.html + "</div>";
      }).join("");
  }

  function wireModalTabs(prefix) {
    var tabs = document.querySelectorAll("#" + prefix + "-tabs .page-tab");
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs, function (b) { b.classList.remove("active"); });
        Array.prototype.forEach.call(document.querySelectorAll('[id^="' + prefix + '-tab-"]'),
          function (p) { p.classList.remove("active"); });
        btn.classList.add("active");
        var panel = document.getElementById(prefix + "-tab-" + btn.getAttribute("data-tab"));
        if (panel) panel.classList.add("active");
      });
    });
  }

  // ─── Modal + confirm (polaris openModal / closeModal / showConfirm) ──────────

  var modalReturnFocus = null;

  function openModal(title, bodyHTML, footerHTML, options) {
    var overlay = document.getElementById("modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "modal-overlay";
      overlay.className = "modal-overlay";
      overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">' +
        '<div class="modal-header"><h3 id="modal-title"></h3><button class="btn-icon modal-close" aria-label="Close dialog">&times;</button></div>' +
        '<div class="modal-body"></div><div class="modal-footer"></div></div>';
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
      overlay.querySelector(".modal-close").addEventListener("click", closeModal);
      document.addEventListener("keydown", function (e) {
        // A stacked confirm owns Escape while it is up.
        if (e.key === "Escape" && overlay.classList.contains("open") && !document.querySelector(".intg-confirm")) closeModal();
      });
    }
    var modal = overlay.querySelector(".modal");
    modal.classList.remove("modal-wide", "modal-xl");
    if (options && options.wide) modal.classList.add("modal-wide");
    if (options && options.xl) modal.classList.add("modal-xl");
    overlay.querySelector(".modal-header h3").textContent = title;
    overlay.querySelector(".modal-body").innerHTML = bodyHTML;
    overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
    modalReturnFocus = document.activeElement;
    // rAF gives the transition a start state; the timeout covers a hidden tab
    // where rAF never fires.
    var opened = false;
    var reveal = function () {
      if (opened) return;
      opened = true;
      overlay.classList.add("open");
      var first = modal.querySelector(".modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea");
      if (first) { try { first.focus(); } catch (_) { /* gone */ } }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
    var closeBtn = overlay.querySelector(".modal-footer [data-close]");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
  }

  function closeModal() {
    var overlay = document.getElementById("modal-overlay");
    if (overlay) overlay.classList.remove("open");
    if (modalReturnFocus && typeof modalReturnFocus.focus === "function") {
      try { modalReturnFocus.focus(); } catch (_) { /* element gone */ }
    }
    modalReturnFocus = null;
  }

  // A standalone overlay STACKED above any open modal, so a confirm raised from
  // inside a dialog leaves that dialog's form intact.
  function showConfirm(message, okLabel) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay intg-confirm";
      overlay.style.zIndex = "1300";
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Confirm" tabindex="-1">' +
          '<div class="modal-header"><h3>Confirm</h3></div>' +
          '<div class="modal-body"><p style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap"></p></div>' +
          '<div class="modal-footer">' +
            '<button class="btn btn-secondary" data-confirm="cancel">Cancel</button>' +
            '<button class="btn btn-danger" data-confirm="ok"></button>' +
          "</div>" +
        "</div>";
      overlay.querySelector(".modal-body p").textContent = message;
      overlay.querySelector('[data-confirm="ok"]').textContent = okLabel || "Confirm";
      document.body.appendChild(overlay);
      var settled = false;
      function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } }
      function done(v) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.classList.remove("open");
        setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 300);
        resolve(v);
      }
      document.addEventListener("keydown", onKey, true);
      overlay.querySelector('[data-confirm="cancel"]').addEventListener("click", function () { done(false); });
      overlay.querySelector('[data-confirm="ok"]').addEventListener("click", function () { done(true); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
      requestAnimationFrame(function () {
        overlay.classList.add("open");
        overlay.querySelector('[data-confirm="cancel"]').focus();
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  // ─── Health summary (failed last test) ───────────────────────────────────────

  async function loadHealthSummary() {
    var host = document.getElementById("integrations-health");
    try {
      var s = await window.api.get("/integrations/health-summary");
      var html = "";
      if (s.failed && s.failed.length) {
        html += calloutHTML("warning",
          s.failed.length + " integration" + (s.failed.length === 1 ? "" : "s") + " failed the last connection test",
          s.failed.map(function (f) { return "<strong>" + esc(f.name) + "</strong> (" + esc(BADGES[f.type] || f.type) + ")"; }).join(", ") +
          ". The health check re-tests every enabled integration every 10 minutes.");
      }
      if (s.proxyAdvice && s.proxyAdvice.length) {
        html += calloutHTML("tip", "Consider direct mode",
          s.proxyAdvice.map(function (p) { return "<strong>" + esc(p.name) + "</strong>"; }).join(", ") +
          " manage more than " + esc(s.proxyAdviceThreshold) + " FortiGates through the FortiManager proxy, which serializes per-device calls. " +
          "Direct mode (FortiManager &rarr; Edit &rarr; Direct Mode) reaches each FortiGate in parallel.");
      }
      host.innerHTML = html;
    } catch (_) { host.innerHTML = ""; }
  }

  // ─── Card list ───────────────────────────────────────────────────────────────

  function detailRow(label, valueHtml) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value">' + valueHtml + "</span></div>";
  }
  function monoRow(label, text) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value mono">' + esc(text || "-") + "</span></div>";
  }
  function muted(text) { return '<span style="color:var(--color-text-tertiary)">' + esc(text) + "</span>"; }

  function filterRow(baseLabel, include, exclude) {
    include = include || []; exclude = exclude || [];
    var label = include.length > 0 ? baseLabel + " Include" : baseLabel + " Exclude";
    var list = include.length > 0 ? include : exclude;
    return detailRow(label, list.length > 0 ? esc(list.join(", ")) : muted("None"));
  }

  function fmtTime(t) {
    return t ? esc(new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })) : muted("Never");
  }

  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60 < 10 ? "0" : "") + (s % 60) + "s";
    return Math.floor(s / 3600) + "h " + (Math.floor(s / 60) % 60) + "m";
  }

  function detailRowsFor(intg) {
    var c = intg.config || {};
    if (intg.type === "fortimanager") {
      return monoRow("Host", (c.host || "-") + ":" + (c.port || 443)) +
        detailRow("API User", esc(c.apiUser || "-")) +
        detailRow("ADOM", esc(c.adom || "root")) +
        detailRow("Verify TLS", c.verifySsl === false ? "No (pinned on first use)" : "Yes") +
        detailRow("Transport", c.useProxy === false ? "Direct to each FortiGate" : "FortiManager proxy") +
        monoRow("Mgmt Interface", c.mgmtInterface) +
        filterRow("FortiGates", c.deviceInclude, c.deviceExclude) +
        detailRow("Worker", '<span id="fmg-activity-' + esc(intg.id) + '">' + muted("—") + "</span>");
    }
    if (intg.type === "fortigate") {
      return monoRow("Host", (c.host || "-") + ":" + (c.port || 443)) +
        detailRow("API User", esc(c.apiUser || "-")) +
        detailRow("VDOM", esc(c.vdom || "root")) +
        detailRow("Verify TLS", c.verifySsl === false ? "No (pinned on first use)" : "Yes") +
        monoRow("Mgmt Interface", c.mgmtInterface);
    }
    if (intg.type === "entraid") {
      return monoRow("Tenant ID", c.tenantId) +
        monoRow("Client ID", c.clientId) +
        detailRow("Intune", c.enableIntune ? "Enabled" : "Disabled") +
        detailRow("Include Disabled", c.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") +
        detailRow("Publish to Intune", c.publishToIntune ? "Allowed (unassigned only)" : "Off") +
        filterRow("Devices", c.deviceInclude, c.deviceExclude);
    }
    // activedirectory
    return monoRow("Host", (c.host || "-") + ":" + (c.port || (c.useLdaps === false ? 389 : 636))) +
      detailRow("Protocol", c.useLdaps === false ? "LDAP" : "LDAPS") +
      detailRow("Verify TLS", c.useLdaps === false ? "—" : (c.verifyTls === false ? "No (pinned on first use)" : "Yes")) +
      monoRow("Bind DN", c.bindDn) +
      monoRow("Base DN", c.baseDn) +
      detailRow("Search Scope", c.searchScope === "one" ? "One level" : "Subtree") +
      detailRow("Include Disabled", c.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") +
      filterRow("OUs", c.ouInclude, c.ouExclude);
  }

  function discoveryRowsFor(intg) {
    var next;
    if (!intg.enabled) next = muted("Integration disabled");
    else if (!intg.lastTestOk || intg.autoDiscover === false) next = muted("—");
    else {
      var intervalMs = (intg.pollInterval || 4) * 3600000;
      next = fmtTime(intg.lastDiscoveryAt ? new Date(intg.lastDiscoveryAt).getTime() + intervalMs : Date.now());
    }
    var hours = intg.pollInterval || 4;
    return detailRow("Auto-Discovery",
        !intg.lastTestOk ? muted("Disabled until a successful connection test")
          : intg.autoDiscover === false ? muted("Disabled")
          : "Every " + hours + " hour" + (hours === 1 ? "" : "s")) +
      detailRow("Last Discovery", fmtTime(intg.lastDiscoveryAt)) +
      detailRow("Next Auto-Discovery", next);
  }

  // Charon's enforcement row: the mode badge, the toggle (enforcement:fullwrite)
  // and the sync-state view (enforcement:read).
  function enforcementRowsFor(intg) {
    var enforcing = intg.enforcementMode === "enforce";
    var badge = enforcing
      ? '<span class="badge badge-conflict">ENFORCING (live)</span>'
      : '<span class="badge badge-maintenance">Dry-run</span>';
    var toggle = perms.enforceWrite
      ? ' <button class="btn btn-sm btn-secondary" data-act="enforce" data-id="' + esc(intg.id) + '" data-mode="' +
        (enforcing ? "dry_run" : "enforce") + '">' + (enforcing ? "Switch to dry-run" : "Enable enforcement") + "</button>"
      : "";
    var view = perms.enforceRead
      ? ' <button class="btn btn-sm btn-secondary" data-act="syncstate" data-id="' + esc(intg.id) + '">Sync State</button>'
      : "";
    return detailRow("Enforcement", badge + toggle + view) +
      detailRow("Last Sync", fmtTime(intg.lastSyncAt));
  }

  function discoverHTML(intg) {
    var run = activeRuns[intg.id];
    if (run) {
      var progress = run.status === "queued" ? "Queued"
        : "Discovering" + (run.totalObjects ? " " + (run.completedCount || 0) + "/" + run.totalObjects : "") + " · " + fmtElapsed(run.elapsedMs);
      // Cancelling is disruptive: DELETE /:id/discover is integrations:fullwrite.
      var abort = perms.fullwrite
        ? '<button class="query-abort-btn" style="margin-left:2px" data-act="abort" data-id="' + esc(intg.id) + '" title="Cancel discovery" aria-label="Cancel discovery">&#x2715;</button>'
        : "";
      return '<span style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;padding:0.3rem 0.6rem;border-radius:var(--radius-md);font-weight:500;' +
        'background:color-mix(in srgb, var(--color-accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);color:var(--color-accent)">' +
        '<span class="query-spinner"></span><span>' + esc(progress) + "…</span>" + abort + "</span>";
    }
    if (!perms.write) return "";
    var disabled = intg.lastTestOk !== true;
    return '<button class="btn btn-sm btn-primary" data-act="discover" data-id="' + esc(intg.id) + '"' +
      (disabled ? ' disabled title="Run a successful test first"' : "") + ">Discover</button>";
  }

  function cardHTML(intg) {
    var statusDot = intg.lastTestOk === true ? "dot-ok" : intg.lastTestOk === false ? "dot-fail" : "dot-unknown";
    var statusText = intg.lastTestOk === true ? "Connected" : intg.lastTestOk === false ? "Failed" : "Not tested";
    var isDir = !!DIRECTORY_TYPES[intg.type];
    var id = esc(intg.id);
    var actions =
      (perms.fullwrite ? '<button class="btn btn-sm btn-secondary" data-act="query" data-id="' + id + '">Query API</button>' : "") +
      (perms.write
        ? '<button class="btn btn-sm btn-secondary" data-act="test" data-id="' + id + '">Test Connection</button>' +
          '<button class="btn btn-sm btn-secondary" data-act="edit" data-id="' + id + '">Edit</button>' +
          '<button class="btn btn-sm btn-danger" data-act="delete" data-id="' + id + '">Delete</button>'
        : "");
    return '<div class="integration-card" data-card-id="' + id + '">' +
      '<div class="integration-card-header">' +
        '<div class="integration-card-header-top integration-card-header-top--centered">' +
          '<div class="integration-card-title">' +
            '<span class="integration-type-badge">' + esc(BADGES[intg.type] || intg.type) + "</span>" +
            "<strong>" + esc(intg.name) + "</strong>" +
            '<span class="integration-status ' + statusDot + '" title="' + esc(intg.lastTestAt ? "Last tested " + new Date(intg.lastTestAt).toLocaleString() : "Never tested") + '">' + statusText + "</span>" +
          "</div>" +
          '<div class="integration-card-enabled">' +
            (intg.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-deprecated">Disabled</span>') +
          "</div>" +
          (isDir ? '<div class="integration-card-discover" id="discover-wrap-' + id + '">' + discoverHTML(intg) + "</div>" : "") +
        "</div>" +
        (actions ? '<div class="integration-card-actions">' + actions + "</div>" : "") +
      "</div>" +
      '<div class="integration-card-details">' +
        detailRowsFor(intg) +
        detailRow("Last Test", intg.lastTestAt ? fmtTime(intg.lastTestAt) + (intg.lastTestOk === false ? ' <span style="color:var(--color-danger)">(failed)</span>' : "") : muted("Never")) +
        (isDir ? discoveryRowsFor(intg) : "") +
        (ENFORCE_TYPES[intg.type] ? enforcementRowsFor(intg) : "") +
      "</div>" +
    "</div>";
  }

  async function loadIntegrations() {
    var container = document.getElementById("integrations-list");
    try {
      var result = await window.api.get("/integrations");
      integrations = result.integrations || [];
      if (integrations.length === 0) {
        container.innerHTML = '<div class="empty-state-card"><p>No integrations configured.</p>' +
          '<p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Add a FortiManager or FortiGate as an enforcement target, ' +
          "and Active Directory or Microsoft Entra ID (with optional Intune) as identity and posture sources. Secrets are encrypted at rest and never shown after saving.</p></div>";
        return;
      }
      container.innerHTML = integrations.map(cardHTML).join("");
      refreshFmgActivity();
    } catch (err) {
      container.innerHTML = '<p class="empty-state">Error: ' + esc(err.message) + "</p>";
    }
  }

  function findIntegration(id) {
    for (var i = 0; i < integrations.length; i++) if (integrations[i].id === id) return integrations[i];
    return null;
  }

  function onCardClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    var intg = findIntegration(id);
    if (!intg) return;
    var act = btn.getAttribute("data-act");
    if (act === "edit") openIntegrationEditModal(id);
    else if (act === "delete") confirmDeleteIntegration(intg);
    else if (act === "test") testConnection(intg, btn);
    else if (act === "discover") runDiscovery(intg, btn);
    else if (act === "abort") abortDiscovery(intg);
    else if (act === "enforce") setEnforcement(intg, btn.getAttribute("data-mode"));
    else if (act === "syncstate") openSyncStateModal(intg);
    else if (act === "query") openQueryConsole(intg);
  }

  // ─── Discovery polling + FMG worker readout ──────────────────────────────────

  // Fast while a run is live, slow otherwise (the scheduler starts runs too).
  async function pollDiscoveries() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    var before = Object.keys(activeRuns);
    if (document.visibilityState !== "hidden") {
      try {
        var r = await window.api.get("/integrations/discoveries");
        var next = {};
        (r.discoveries || []).forEach(function (d) { next[d.id] = d; });
        activeRuns = next;
        var finished = before.some(function (id) { return !next[id]; });
        if (finished) loadIntegrations();
        else updateDiscoverWraps();
      } catch (_) { /* next tick retries */ }
      refreshFmgActivity();
    }
    var live = Object.keys(activeRuns).length > 0;
    pollTimer = setTimeout(pollDiscoveries, live ? 4000 : 30000);
  }

  function updateDiscoverWraps() {
    integrations.forEach(function (intg) {
      var wrap = document.getElementById("discover-wrap-" + intg.id);
      if (wrap) wrap.innerHTML = discoverHTML(intg);
    });
  }

  // GET /:id/fmg-activity — the FortiManager worker's proxy / native lanes,
  // from the process that runs FMG traffic (a heartbeat snapshot).
  function refreshFmgActivity() {
    integrations.forEach(function (intg) {
      if (intg.type !== "fortimanager") return;
      var el = document.getElementById("fmg-activity-" + intg.id);
      if (!el) return;
      window.api.get("/integrations/" + encodeURIComponent(intg.id) + "/fmg-activity").then(function (a) {
        if (!a.fresh) { el.innerHTML = muted("Idle (no live worker heartbeat)"); return; }
        var parts = [];
        parts.push(a.proxyInFlightLabel ? "Proxy: " + esc(a.proxyInFlightLabel) : "Proxy: idle");
        if (a.proxyQueueDepth) parts.push(esc(a.proxyQueueDepth) + " queued");
        parts.push(esc(a.nativeInFlightCount || 0) + " native in flight");
        el.innerHTML = parts.join(" · ");
      }).catch(function () { el.innerHTML = muted("—"); });
    });
  }

  // ─── Card actions ────────────────────────────────────────────────────────────

  // Direct-mode sanity check after a successful FortiManager test: one random
  // managed FortiGate with the fleet token. Fire-and-forget so the FMG toast is
  // not held up by a slow or unreachable gate. Tests the SAVED configuration.
  function runFortigateSampleProbe(id) {
    window.api.post("/integrations/" + encodeURIComponent(id) + "/test/fortigate-sample")
      .then(function (r) {
        toast((r.deviceName ? r.deviceName + ": " : "") + r.message, r.ok ? "success" : "error");
      })
      .catch(function (err) { toast("Random FortiGate test failed: " + (err && err.message ? err.message : "unknown error"), "error"); });
  }

  async function testConnection(intg, btn) {
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      var result = await window.api.post("/integrations/" + encodeURIComponent(intg.id) + "/test");
      toast(result.message + (result.version ? " (" + result.version + ")" : ""), result.ok ? "success" : "error");
      if (result.ok && intg.type === "fortimanager" && (intg.config || {}).useProxy === false) runFortigateSampleProbe(intg.id);
      loadIntegrations();
      loadHealthSummary();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Test Connection";
    }
  }

  async function runDiscovery(intg, btn) {
    btn.disabled = true;
    try {
      var r = await window.api.post("/integrations/" + encodeURIComponent(intg.id) + "/discover");
      toast(r.alreadyRunning ? "A discovery of \"" + intg.name + "\" is already running" : "Discovery started — running in the background", "success");
      activeRuns[intg.id] = activeRuns[intg.id] || { id: intg.id, status: "queued", elapsedMs: 0 };
      updateDiscoverWraps();
      pollDiscoveries();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  }

  async function abortDiscovery(intg) {
    var ok = await showConfirm('Cancel the running discovery of "' + intg.name + '"?', "Cancel discovery");
    if (!ok) return;
    try {
      await window.api.del("/integrations/" + encodeURIComponent(intg.id) + "/discover");
      toast("Cancellation requested", "success");
    } catch (err) {
      toast(err.status === 404 ? "No discovery is running for this integration" : err.message, "error");
    }
    pollDiscoveries();
  }

  async function confirmDeleteIntegration(intg) {
    var extra = ENFORCE_TYPES[intg.type]
      ? "\n\nCharon stops managing this device. charon-* objects it already wrote stay on the firewall until removed there."
      : "\n\nIts directory objects are removed from Charon, and tags sourced from them stop applying.";
    var ok = await showConfirm('Delete integration "' + intg.name + '"? This cannot be undone.' + extra, "Delete");
    if (!ok) return;
    try {
      await window.api.del("/integrations/" + encodeURIComponent(intg.id));
      toast("Integration deleted", "success");
      loadIntegrations();
      loadHealthSummary();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function setEnforcement(intg, mode) {
    if (mode === "enforce") {
      var ok = await showConfirm('Enable LIVE Fortinet enforcement for "' + intg.name + '"?\n\n' +
        "Charon will begin writing charon-* address objects, address groups and policies to the firewall. " +
        "A human must have reviewed the intended (dry-run) changes in Sync State first.", "Enable enforcement");
      if (!ok) return;
    }
    try {
      await window.api.patch("/integrations/" + encodeURIComponent(intg.id) + "/enforcement", { mode: mode });
      toast(mode === "enforce" ? "Enforcement is LIVE for \"" + intg.name + "\"" : "\"" + intg.name + "\" switched to dry-run", mode === "enforce" ? "error" : "success");
      loadIntegrations();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ─── Sync state (drift) view — Charon's ──────────────────────────────────────

  var SYNC_BADGES = {
    in_sync: '<span class="badge badge-active">In sync</span>',
    pending: '<span class="badge badge-maintenance">Pending</span>',
    dry_run: '<span class="badge badge-maintenance">Dry-run</span>',
    drift: '<span class="badge badge-conflict">Drift</span>',
    error: '<span class="badge badge-conflict">Error</span>',
  };

  async function openSyncStateModal(intg) {
    openModal("Sync State — " + intg.name, '<p class="empty-state">Loading...</p>',
      '<button class="btn btn-secondary" data-close>Close</button>', { wide: true });
    var body = document.querySelector("#modal-overlay .modal-body");
    try {
      var r = await window.api.get("/integrations/" + encodeURIComponent(intg.id) + "/enforcement-state");
      var states = r.states || [];
      var counts = {};
      states.forEach(function (s) { counts[s.status] = (counts[s.status] || 0) + 1; });
      var summary = Object.keys(counts).map(function (k) { return (SYNC_BADGES[k] || esc(k)) + " " + counts[k]; }).join(" &nbsp; ");
      var rows = states.map(function (s) {
        return "<tr><td>" + esc(s.objectType) + '</td><td class="mono">' + esc(s.objectName) + "</td><td>" +
          (SYNC_BADGES[s.status] || esc(s.status)) + "</td><td>" + (s.lastAppliedAt ? esc(new Date(s.lastAppliedAt).toLocaleString()) : muted("—")) +
          "</td><td>" + (s.lastError ? '<span style="color:var(--color-danger)">' + esc(s.lastError) + "</span>" : "") + "</td></tr>";
      }).join("");
      body.innerHTML =
        '<p class="hint" style="margin-top:0">Charon-managed objects on this firewall and how each compares with what Charon intends. ' +
        (intg.enforcementMode === "enforce" ? "Enforcement is <strong>live</strong>." : "Enforcement is in <strong>dry-run</strong>: intended changes are logged, nothing is written.") +
        "</p>" +
        (states.length ? '<p style="margin:0 0 0.75rem">' + summary + "</p>" +
          '<div class="table-wrapper"><table><thead><tr><th>Type</th><th>Object</th><th>Status</th><th>Last Applied</th><th>Last Error</th></tr></thead><tbody>' +
          rows + "</tbody></table></div>"
          : '<div class="empty-state">No charon-* objects tracked for this integration yet.</div>');
    } catch (err) {
      body.innerHTML = '<p class="empty-state">Error: ' + esc(err.message) + "</p>";
    }
  }

  // ─── Type picker ─────────────────────────────────────────────────────────────

  function showTypePicker() {
    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Select the type of integration to add:</p>' +
      '<div class="type-picker">' +
        TYPE_ORDER.map(function (t) {
          return '<button type="button" class="type-card" data-type="' + t + '">' +
            '<span class="type-card-title">' + esc(PRODUCTS[t]) + "</span>" +
            '<span class="type-card-desc">' + esc(TYPE_DESC[t]) + "</span></button>";
        }).join("") +
      "</div>";
    openModal("Add Integration", body, '<button class="btn btn-secondary" data-close>Cancel</button>', { wide: true });
    document.querySelectorAll("#modal-overlay .type-card").forEach(function (btn) {
      btn.addEventListener("click", function () { openIntegrationCreateModal(btn.getAttribute("data-type")); });
    });
  }

  // ─── FortiManager form ───────────────────────────────────────────────────────

  function nameField(d, placeholder) {
    return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + esc(d.name || "") +
      '" placeholder="' + placeholder + '"></div>';
  }

  function enabledRow(d) { return checkboxRow("f-enabled", "Enabled", d.enabled !== false); }

  function fortiManagerGeneralHTML(d) {
    return nameField(d, "e.g. Production FortiManager") +
      infoBox('For <strong style="color:var(--color-text-primary)">on-premise FortiManager</strong> (not FortiManager Cloud), version ' +
        '<strong style="color:var(--color-text-primary)">7.4.7+</strong> or <strong style="color:var(--color-text-primary)">7.6.2+</strong> — older versions do not support bearer-token authentication. ' +
        "Charon only ever writes <code>charon-*</code> address objects, address groups and policies, and only once enforcement is switched on; until then every intended change is logged as dry-run.") +
      formDivider() +
      sectionHeading("Connection Settings") +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
        '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + esc(d.host || "") + '" placeholder="e.g. fmg.example.com"></div>' +
        '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
      "</div>" +
      '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + esc(d.apiUser || "") + '" placeholder="e.g. charon-api"></div>' +
      secretInput("f-apiToken", "API Token *", isStored(d.apiToken), "Bearer token", "Leave blank to keep current token",
        "Generate from FortiManager under System Settings &gt; Admin &gt; API Users") +
      '<div class="form-group"><label>ADOM</label><input type="text" id="f-adom" value="' + esc(d.adom || "root") + '" placeholder="root"><p class="hint">Administrative Domain (leave as "root" for default)</p></div>' +
      '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + esc(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface whose IP Charon uses to reach each managed FortiGate in direct mode</p></div>' +
      checkboxRow("f-verifySsl", "Verify TLS certificate", d.verifySsl !== false) +
      tlsOffHint("the FortiManager") +
      formDivider() +
      enabledRow(d);
  }

  function fortiManagerFiltersHTML(d) {
    return sectionHeading("FortiGate Device Filter") +
      filterBlock("f-deviceMode", "f-deviceNames", d.deviceInclude, d.deviceExclude,
        "these managed FortiGates",
        "One per line — e.g. FG-HQ-01&#10;FG-DC-*&#10;*-lab",
        "Leave empty to target every managed FortiGate in the ADOM. Matched against device name or hostname. Wildcards supported: <code>FG-*</code>, <code>*-lab</code>, <code>*dc*</code>");
  }

  // Direct mode. The UI checkbox is inverted vs. the stored field:
  // checked = direct (useProxy=false), unchecked = FortiManager proxy.
  function fortiManagerDirectHTML(d) {
    var direct = d.useProxy === false;
    return sectionHeading("Transport") +
      '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
          '<input type="checkbox" id="f-useDirect"' + (direct ? " checked" : "") + ' style="width:auto">' +
          '<label for="f-useDirect" style="margin:0;font-weight:500">Direct mode</label>' +
        "</div>" +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0">' +
          "Bypass the FortiManager proxy and reach each managed FortiGate's REST API directly, in parallel. " +
          "The FortiManager is still used to list devices and resolve each one's management IP (Management Interface on the General tab). " +
          "Recommended past 10 FortiGates — the proxy serializes per-device calls.</p>" +
      "</div>" +
      sectionHeading("FortiGate REST Credentials") +
      '<p class="hint" style="margin:0 0 0.75rem 0">Used in direct mode only. The same REST API admin and token must exist on every managed FortiGate.</p>' +
      '<div class="form-group"><label>FortiGate API User</label><input type="text" id="f-fortigateApiUser" value="' + esc(d.fortigateApiUser || "") + '" placeholder="e.g. charon-api"><p class="hint">REST API admin username configured on each managed FortiGate</p></div>' +
      secretInput("f-fortigateApiToken", "FortiGate API Token", isStored(d.fortigateApiToken), "Bearer token", "Leave blank to keep current token",
        "Bearer token for the admin above — identical across the fleet") +
      checkboxRow("f-fortigateVerifySsl", "Verify TLS certificate on FortiGates", d.fortigateVerifySsl !== false) +
      tlsOffHint("each FortiGate") +
      calloutHTML("warning", "Scope the token",
        "Grant the REST API admin only what enforcement needs (firewall address and policy configuration) and set its " +
        "<strong>trusthost</strong> to the Charon host's address. A FortiOS access profile is per-group, not per-object, " +
        "so Read-Write on a group covers every object in it. Rotate the token like any other admin secret.");
  }

  function readFortiManagerForm() {
    var dev = readFilter("f-deviceMode", "f-deviceNames");
    var port = parseInt(val("f-port"), 10);
    return {
      host: val("f-host"),
      port: port >= 1 && port <= 65535 ? port : 443,
      apiUser: val("f-apiUser"),
      apiToken: val("f-apiToken"),
      adom: val("f-adom") || "root",
      verifySsl: checked("f-verifySsl"),
      mgmtInterface: val("f-mgmtInterface"),
      deviceInclude: dev.include,
      deviceExclude: dev.exclude,
      useProxy: !checked("f-useDirect"),
      fortigateApiUser: val("f-fortigateApiUser"),
      fortigateApiToken: val("f-fortigateApiToken"),
      fortigateVerifySsl: checked("f-fortigateVerifySsl"),
    };
  }

  // ─── FortiGate form ──────────────────────────────────────────────────────────

  function fortiGateGeneralHTML(d) {
    return nameField(d, "e.g. Branch Office FortiGate") +
      infoBox("Connects <strong style=\"color:var(--color-text-primary)\">directly to a standalone FortiGate</strong> (not managed by FortiManager). " +
        "Requires a REST API admin token created under <strong style=\"color:var(--color-text-primary)\">System &gt; Administrators &gt; REST API Admin</strong>. " +
        "Charon only ever writes <code>charon-*</code> objects, and only once enforcement is switched on.") +
      formDivider() +
      sectionHeading("Connection Settings") +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
        '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + esc(d.host || "") + '" placeholder="e.g. fortigate.example.com"></div>' +
        '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
      "</div>" +
      '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + esc(d.apiUser || "") + '" placeholder="e.g. charon-api"></div>' +
      secretInput("f-apiToken", "API Token *", isStored(d.apiToken), "Bearer token", "Leave blank to keep current token",
        "Generate under System &gt; Administrators &gt; Create New &gt; REST API Admin") +
      '<div class="form-group"><label>VDOM</label><input type="text" id="f-vdom" value="' + esc(d.vdom || "root") + '" placeholder="root"><p class="hint">Virtual Domain (leave as "root" for default)</p></div>' +
      '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + esc(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface used for FortiGate management traffic</p></div>' +
      checkboxRow("f-verifySsl", "Verify TLS certificate", d.verifySsl !== false) +
      tlsOffHint("the FortiGate") +
      calloutHTML("warning", "Scope the token",
        "Grant the REST API admin only what enforcement needs (firewall address and policy configuration) and set its " +
        "<strong>trusthost</strong> to the Charon host's address. Rotate the token like any other admin secret.") +
      formDivider() +
      enabledRow(d);
  }

  function readFortiGateForm() {
    var port = parseInt(val("f-port"), 10);
    return {
      host: val("f-host"),
      port: port >= 1 && port <= 65535 ? port : 443,
      apiUser: val("f-apiUser"),
      apiToken: val("f-apiToken"),
      vdom: val("f-vdom") || "root",
      verifySsl: checked("f-verifySsl"),
      mgmtInterface: val("f-mgmtInterface"),
    };
  }

  // ─── Entra ID (+ Intune) form ────────────────────────────────────────────────

  function strong(t) { return '<strong style="color:var(--color-text-primary)">' + t + "</strong>"; }

  function entraIdGeneralHTML(d) {
    return nameField(d, "e.g. Corporate Entra ID") +
      infoBox("Connects to " + strong("Microsoft Entra ID") + " through an app registration (client-credentials flow) and reads users, groups and devices into Charon's directory mirror — read-only. " +
        "Required Microsoft Graph <em>application</em> permissions: " + strong("Device.Read.All") + ", " + strong("User.Read.All") + " and " +
        strong("GroupMember.Read.All") + " (or " + strong("Directory.Read.All") + " instead), plus " + strong("DeviceManagementManagedDevices.Read.All") +
        " when Intune is on. Grant admin consent in the Entra admin center.") +
      formDivider() +
      sectionHeading("Connection Settings") +
      '<div class="form-group"><label>Tenant ID *</label><input type="text" id="f-tenantId" value="' + esc(d.tenantId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Directory (tenant) ID from Entra ID &gt; Overview</p></div>' +
      '<div class="form-group"><label>Client ID *</label><input type="text" id="f-clientId" value="' + esc(d.clientId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Application (client) ID from App registrations &gt; Overview</p></div>' +
      secretInput("f-clientSecret", "Client Secret *", isStored(d.clientSecret), "Secret value", "Leave blank to keep current secret",
        "App registrations &gt; Certificates &amp; secrets &gt; New client secret (save the Value, not the ID)") +
      checkboxRow("f-enableIntune", "Enable Intune device posture", d.enableIntune === true) +
      infoBox("When on, overlays Intune managed-device data (compliance state, serial, MAC, primary user) from <code>/deviceManagement/managedDevices</code> onto the Entra devices, for posture tag sources. " +
        "Requires an Intune license and " + strong("DeviceManagementManagedDevices.Read.All") + ".") +
      checkboxRow("f-includeDisabled", "Include disabled accounts and devices (as <em>disabled</em>)", d.includeDisabled !== false) +
      formDivider() +
      enabledRow(d) +
      checkboxRow("f-autoDiscover", "Enable auto-discovery", d.autoDiscover !== false) +
      hoursField(d, "How often to re-read Graph");
  }

  function entraIdFiltersHTML(d) {
    return sectionHeading("Device Filter") +
      filterBlock("f-deviceMode", "f-deviceNames", d.deviceInclude, d.deviceExclude,
        "these devices by display name",
        "One per line — e.g. LAPTOP-*&#10;SRV-HQ-*&#10;*-lab",
        "Leave empty to read every device. Users and groups are not filtered. Wildcards supported: <code>LAPTOP-*</code>, <code>*-lab</code>, <code>*pc*</code>");
  }

  // The opt-in WRITE capability on an otherwise read-only credential.
  function entraIdPublishHTML(d) {
    return sectionHeading("Publish agent onboarding to Intune (opt-in)") +
      '<p class="hint" style="margin:0 0 0.75rem 0">' +
        "Lets Charon upload the Charon agent onboarding script to Intune as a <strong>Remediation</strong>, instead of you downloading it and creating the policy by hand. " +
        "Re-publishing updates the same policy rather than creating a second one.</p>" +
      checkboxRow("f-publishToIntune", "Allow Charon to publish agent onboarding scripts to Intune", d.publishToIntune === true) +
      formDivider() +
      sectionHeading("Required in Entra before this works") +
      '<ol class="hint" style="margin:0 0 0.5rem 0;padding-left:1.2rem">' +
        "<li>Open this app registration under <strong>Entra ID &rarr; App registrations &rarr; API permissions</strong>.</li>" +
        "<li>Add the Microsoft Graph <strong>application</strong> permission <code>DeviceManagementScripts.ReadWrite.All</code>.</li>" +
        "<li><strong>Grant admin consent</strong> for the tenant — application permissions do not work without it.</li>" +
      "</ol>" +
      '<p class="hint" style="margin:0">Discovery keeps working on its read permissions; this is additive.</p>' +
      calloutHTML("warning", "What you are granting",
        "This upgrades the credential from &ldquo;reads your directory&rdquo; to &ldquo;creates device-management policy across the tenant&rdquo;, " +
        "and an application permission acts tenant-wide with no user context. <strong>Charon only ever publishes UNASSIGNED remediations</strong> — " +
        "uploaded targeting nothing. Choosing which devices run it stays a human decision you make in the Intune console after reading the script.");
  }

  function readEntraIdForm() {
    var dev = readFilter("f-deviceMode", "f-deviceNames");
    return {
      tenantId: val("f-tenantId"),
      clientId: val("f-clientId"),
      clientSecret: val("f-clientSecret"),
      enableIntune: checked("f-enableIntune"),
      includeDisabled: checked("f-includeDisabled"),
      deviceInclude: dev.include,
      deviceExclude: dev.exclude,
      publishToIntune: checked("f-publishToIntune"),
    };
  }

  // ─── Active Directory form ───────────────────────────────────────────────────

  function activeDirectoryGeneralHTML(d) {
    var useLdaps = d.useLdaps !== false;
    var scope = d.searchScope === "one" ? "one" : "sub";
    return nameField(d, "e.g. Corp AD — DC01") +
      infoBox("Connects to an " + strong("on-premise Active Directory") + " domain controller with an LDAP simple bind and reads users, groups, computers and OUs into Charon's directory mirror — read-only. " +
        "A read-only domain account is sufficient.") +
      formDivider() +
      sectionHeading("Connection Settings") +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
        '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + esc(d.host || "") + '" placeholder="e.g. dc01.example.com"></div>' +
        '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || (useLdaps ? 636 : 389)) + '" min="1" max="65535" style="width:90px"></div>' +
      "</div>" +
      checkboxRow("f-useLdaps", "Use LDAPS (TLS)", useLdaps) +
      '<p class="hint" id="f-ldaps-warn" style="color:var(--color-warning);' + (useLdaps ? "display:none" : "") + '">Plain LDAP sends the bind password in clear text. Use LDAPS.</p>' +
      checkboxRow("f-verifyTls", "Verify TLS certificate", d.verifyTls !== false) +
      tlsOffHint("the domain controller") +
      '<div class="form-group"><label>Bind DN *</label><input type="text" id="f-bindDn" value="' + esc(d.bindDn || "") + '" placeholder="e.g. CN=charon-svc,OU=Service Accounts,DC=example,DC=com"><p class="hint">Distinguished name of the bind account</p></div>' +
      secretInput("f-bindPassword", "Bind Password *", isStored(d.bindPassword), "Password", "Leave blank to keep current password", "") +
      '<div class="form-group"><label>Base DN *</label><input type="text" id="f-baseDn" value="' + esc(d.baseDn || "") + '" placeholder="e.g. DC=example,DC=com"><p class="hint">Subtree to read. Narrow it (e.g. <code>OU=Corp,DC=example,DC=com</code>) to mirror only part of the directory.</p></div>' +
      '<div class="form-group"><label>Search Scope</label>' +
        '<select id="f-searchScope" style="width:auto">' +
          '<option value="sub"' + (scope === "sub" ? " selected" : "") + ">Subtree (recursive)</option>" +
          '<option value="one"' + (scope === "one" ? " selected" : "") + ">One level (immediate children only)</option>" +
        "</select>" +
      "</div>" +
      checkboxRow("f-includeDisabled", "Include disabled accounts (as <em>disabled</em>)", d.includeDisabled !== false) +
      formDivider() +
      enabledRow(d) +
      checkboxRow("f-autoDiscover", "Enable auto-discovery", d.autoDiscover !== false) +
      hoursField(d, "How often to re-read the directory");
  }

  function activeDirectoryFiltersHTML(d) {
    return sectionHeading("OU Filter") +
      filterBlock("f-deviceMode", "f-deviceNames", d.ouInclude, d.ouExclude,
        "these OUs (matched against distinguished name)",
        "One per line — e.g.&#10;*OU=Workstations*&#10;*OU=Servers,OU=HQ*",
        "Leave empty to read everything under the base DN. Each line is matched against the object's full distinguished name. Wildcards: <code>*OU=Workstations*</code>, <code>*OU=Servers,OU=HQ*</code>");
  }

  function readActiveDirectoryForm() {
    var ou = readFilter("f-deviceMode", "f-deviceNames");
    var useLdaps = checked("f-useLdaps");
    var port = parseInt(val("f-port"), 10);
    return {
      host: val("f-host"),
      port: port >= 1 && port <= 65535 ? port : (useLdaps ? 636 : 389),
      useLdaps: useLdaps,
      verifyTls: checked("f-verifyTls"),
      bindDn: val("f-bindDn"),
      bindPassword: val("f-bindPassword"),
      baseDn: val("f-baseDn"),
      searchScope: val("f-searchScope") === "one" ? "one" : "sub",
      ouInclude: ou.include,
      ouExclude: ou.exclude,
      includeDisabled: checked("f-includeDisabled"),
    };
  }

  // Flip the port with the protocol while it still holds the other default.
  function wireActiveDirectoryForm() {
    var ldaps = document.getElementById("f-useLdaps");
    if (!ldaps) return;
    ldaps.addEventListener("change", function () {
      var port = document.getElementById("f-port");
      if (ldaps.checked && port.value === "389") port.value = "636";
      if (!ldaps.checked && port.value === "636") port.value = "389";
      document.getElementById("f-ldaps-warn").style.display = ldaps.checked ? "none" : "";
    });
  }

  // ─── The one shape, for all four types ───────────────────────────────────────

  var FORM_READERS = {
    fortimanager: readFortiManagerForm,
    fortigate: readFortiGateForm,
    entraid: readEntraIdForm,
    activedirectory: readActiveDirectoryForm,
  };

  // [fieldId, label, secret?] — secrets are dropped on Edit, where a stored
  // one renders blank ("leave blank to keep current").
  var REQUIRED_FIELDS = {
    fortimanager: [["f-host", "host"], ["f-apiToken", "API token", true]],
    fortigate: [["f-host", "host"], ["f-apiToken", "API token", true]],
    entraid: [["f-tenantId", "tenant ID"], ["f-clientId", "client ID"], ["f-clientSecret", "client secret", true]],
    activedirectory: [["f-host", "host"], ["f-bindDn", "bind DN"], ["f-bindPassword", "bind password", true], ["f-baseDn", "base DN"]],
  };

  var SECRET_FIELDS = {
    fortimanager: ["apiToken", "fortigateApiToken"],
    fortigate: ["apiToken"],
    entraid: ["clientSecret"],
    activedirectory: ["bindPassword"],
  };

  function requiredFor(type, mode) {
    return (REQUIRED_FIELDS[type] || []).filter(function (f) { return mode !== "edit" || !f[2]; });
  }

  // Tab set per type, for BOTH flows. `d` is the stored config plus the row
  // fields (name, enabled, autoDiscover, pollInterval); empty on create.
  function integrationTabs(type, d) {
    if (type === "fortimanager") {
      return [
        { key: "general", label: "General", html: fortiManagerGeneralHTML(d) },
        { key: "filters", label: "Filters", html: fortiManagerFiltersHTML(d) },
        { key: "direct", label: "Direct Mode", html: fortiManagerDirectHTML(d) },
      ];
    }
    if (type === "fortigate") return null;   // flat form
    if (type === "entraid") {
      return [
        { key: "general", label: "General", html: entraIdGeneralHTML(d) },
        { key: "filters", label: "Filters", html: entraIdFiltersHTML(d) },
        { key: "publish", label: "Script Publishing", html: entraIdPublishHTML(d) },
      ];
    }
    return [
      { key: "general", label: "General", html: activeDirectoryGeneralHTML(d) },
      { key: "filters", label: "Filters", html: activeDirectoryFiltersHTML(d) },
    ];
  }

  function flatFormHTML(type, d) {
    return type === "fortigate" ? fortiGateGeneralHTML(d) : "";
  }

  // Strip blank secrets so the server keeps (and, for a test, reuses) the
  // stored value. A blank secret with a moved host/port/TLS setting is
  // refused server-side with a message naming the field to re-enter.
  function stripBlankSecrets(type, cfg) {
    (SECRET_FIELDS[type] || []).forEach(function (k) { if (!cfg[k] || cfg[k] === MASK) delete cfg[k]; });
    return cfg;
  }

  // polaris openIntegrationModal: title "<Action> <Product> Integration",
  // footer Test Connection · Cancel · Create/Save Changes. Saving is never
  // blocked on a passing test (configuring ahead of a firewall change is
  // legitimate); onSave gets { tested }.
  function openIntegrationModal(cfg) {
    var prefix = "intg-edit";
    var tabs = cfg.tabs;
    var body = tabs ? tabbedBodyHTML(prefix, tabs) : cfg.html;
    var saveLabel = cfg.action === "Edit" ? "Save Changes" : "Create";
    var busyLabel = cfg.action === "Edit" ? "Saving…" : "Creating…";
    var footer =
      '<button class="btn btn-secondary" id="' + prefix + '-test">Test Connection</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-secondary" id="' + prefix + '-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="' + prefix + '-save">' + esc(saveLabel) + "</button>";
    openModal(cfg.action + " " + cfg.product + " Integration", body, footer, { wide: true });
    if (tabs) wireModalTabs(prefix);
    if (cfg.onWire) cfg.onWire();

    function missingFields() {
      var missing = [];
      (cfg.requires || []).forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el && !String(el.value || "").trim()) missing.push(pair[1]);
      });
      return missing;
    }

    function busy(btn, label, fn) {
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = label;
      return Promise.resolve().then(fn).catch(function (err) {
        toast((err && err.message) || "Request failed", "error");
      }).then(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
    }

    var tested = false;
    var testBtn = document.getElementById(prefix + "-test");
    var saveBtn = document.getElementById(prefix + "-save");
    testBtn.addEventListener("click", function () {
      var missing = missingFields();
      if (missing.length) { toast("Fill in " + missing.join(", ") + " first", "error"); return; }
      busy(testBtn, "Testing…", function () {
        return Promise.resolve(cfg.onTest()).then(function (result) { tested = !!(result && result.ok); });
      });
    });
    saveBtn.addEventListener("click", function () {
      if (!val("f-name")) { toast("Enter a name for this integration", "error"); return; }
      busy(saveBtn, busyLabel, function () { return Promise.resolve(cfg.onSave({ tested: tested })); });
    });
    document.getElementById(prefix + "-cancel").addEventListener("click", closeModal);
  }

  function wireIntegrationForm(type) {
    if (type === "activedirectory") wireActiveDirectoryForm();
  }

  function rowFields() {
    var out = { name: val("f-name"), enabled: checked("f-enabled") };
    var auto = document.getElementById("f-autoDiscover");
    if (auto) out.autoDiscover = auto.checked;
    var hours = parseInt(val("f-pollInterval"), 10);
    if (document.getElementById("f-pollInterval")) out.pollInterval = hours >= 1 && hours <= 168 ? hours : 4;
    return out;
  }

  function openIntegrationCreateModal(type) {
    // Secure by default: TLS verification ON for a new integration.
    var d = { verifySsl: true, fortigateVerifySsl: true, verifyTls: true, useLdaps: true, includeDisabled: true, useProxy: true };
    var tabs = integrationTabs(type, d);
    openIntegrationModal({
      product: PRODUCTS[type],
      action: "Add",
      tabs: tabs,
      html: tabs ? null : flatFormHTML(type, d),
      requires: requiredFor(type, "create"),
      onWire: function () { wireIntegrationForm(type); },
      onTest: function () { return testForm(type, null); },
      onSave: function (ctx) { return createIntegration(type, ctx.tested); },
    });
  }

  async function openIntegrationEditModal(id) {
    try {
      var intg = await window.api.get("/integrations/" + encodeURIComponent(id));
      var d = Object.assign({}, intg.config || {}, {
        name: intg.name, enabled: intg.enabled, autoDiscover: intg.autoDiscover, pollInterval: intg.pollInterval,
      });
      var tabs = integrationTabs(intg.type, d);
      openIntegrationModal({
        product: PRODUCTS[intg.type] || intg.type,
        action: "Edit",
        tabs: tabs,
        html: tabs ? null : flatFormHTML(intg.type, d),
        requires: requiredFor(intg.type, "edit"),
        onWire: function () { wireIntegrationForm(intg.type); },
        onTest: function () { return testForm(intg.type, intg); },
        onSave: function () { return saveIntegration(intg); },
      });
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Preflight of the UNSAVED form (POST /test). On Edit, existingId lets the
  // server reuse a stored secret the form left blank — only while the
  // destination is unchanged; otherwise its 400 message is toasted as-is.
  async function testForm(type, intg) {
    var config = stripBlankSecrets(type, FORM_READERS[type]());
    var body = { type: type, config: config };
    if (intg) body.existingId = intg.id;
    var result = await window.api.post("/integrations/test", body);
    toast(result.message + (result.version ? " (" + result.version + ")" : ""), result.ok ? "success" : "error");
    // The fortigate-sample probe runs against the SAVED config, so it only
    // means something here when the stored integration is already in direct mode.
    if (result.ok && intg && type === "fortimanager" && config.useProxy === false && (intg.config || {}).useProxy === false) {
      runFortigateSampleProbe(intg.id);
    }
    return result;
  }

  async function createIntegration(type, tested) {
    var input = Object.assign({ type: type, config: stripBlankSecrets(type, FORM_READERS[type]()) }, rowFields());
    var result = await window.api.post("/integrations", input);
    closeModal();
    toast("Integration created", "success");
    // A test that passed on this form carries over: re-test the saved row so
    // lastTestOk is recorded and Discover is enabled without a manual re-test.
    if (tested && result && result.id) {
      try { await window.api.post("/integrations/" + encodeURIComponent(result.id) + "/test"); } catch (_) { /* retry from the card */ }
    }
    loadIntegrations();
    loadHealthSummary();
  }

  async function saveIntegration(intg) {
    var input = Object.assign({ config: stripBlankSecrets(intg.type, FORM_READERS[intg.type]()) }, rowFields());
    await window.api.put("/integrations/" + encodeURIComponent(intg.id), input);
    closeModal();
    toast("Integration updated", "success");
    loadIntegrations();
    loadHealthSummary();
  }

  // ─── API consoles (READ-ONLY) ────────────────────────────────────────────────
  //
  // POST /:id/query is integrations:fullwrite and audited. Every console only
  // reads: FortiManager JSON-RPC "get", FortiOS / Graph GET, LDAP search. The
  // polaris write-method selectors, request bodies and per-request token
  // override are gone — the server rejects them.

  function makeSavedQueryStore(storageKey, version, presets) {
    return {
      load: function () {
        try {
          var stored = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (!stored || stored.v !== version) {
            // A version bump reseeds the presets (operator-saved names are lost).
            localStorage.setItem(storageKey, JSON.stringify({ v: version, queries: presets.slice() }));
            return presets.slice();
          }
          return stored.queries;
        } catch (_) { return presets.slice(); }
      },
      persist: function (queries) {
        try { localStorage.setItem(storageKey, JSON.stringify({ v: version, queries: queries })); } catch (_) { /* private mode */ }
      },
    };
  }

  // Filtered option list; option values stay the ORIGINAL array index so
  // Load / Delete resolve without remapping.
  function renderSavedSelect(selectId, queries, filter, selectValue) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">— load a saved query —</option>' +
      queries.map(function (q, i) {
        if (filter && !filter(q)) return "";
        return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + ">" + esc(q.name) + "</option>";
      }).join("");
  }

  // Load / Delete / Save against `<prefix>-saved-select` / `<prefix>-save-name`.
  // readForm() returns the query fields (never a credential — this lands in
  // localStorage in the clear); writeForm(q) fills them on Load.
  function wireSavedQueryConsole(store, prefix, readForm, writeForm, filter) {
    var saved = store.load();
    var selectId = prefix + "-saved-select";
    var rerender = function (selectValue) { renderSavedSelect(selectId, saved, filter && filter(), selectValue); };
    rerender();
    document.getElementById(prefix + "-load-btn").addEventListener("click", function () {
      var idx = parseInt(document.getElementById(selectId).value, 10);
      if (isNaN(idx) || !saved[idx]) return;
      writeForm(saved[idx]);
      document.getElementById(prefix + "-save-name").value = saved[idx].name;
    });
    document.getElementById(prefix + "-delete-btn").addEventListener("click", async function () {
      var idx = parseInt(document.getElementById(selectId).value, 10);
      if (isNaN(idx) || !saved[idx]) return;
      if (!(await showConfirm('Delete saved query "' + saved[idx].name + '"?', "Delete"))) return;
      saved.splice(idx, 1);
      store.persist(saved);
      rerender();
    });
    document.getElementById(prefix + "-save-btn").addEventListener("click", function () {
      var name = val(prefix + "-save-name");
      if (!name) { toast("Enter a name for this query", "error"); return; }
      var entry = Object.assign({ name: name }, readForm());
      var existIdx = -1;
      saved.forEach(function (q, i) { if (q.name === name) existIdx = i; });
      if (existIdx >= 0) saved[existIdx] = entry;
      else { saved.push(entry); existIdx = saved.length - 1; }
      store.persist(saved);
      rerender(existIdx);
      toast("Query saved", "success");
    });
    return { rerender: rerender };
  }

  // Shared console chrome: saved-query row, the per-console form, Send, the
  // save-as row and the response panel.
  function consoleHTML(prefix, formHtml) {
    return '<div style="margin-bottom:0.75rem">' +
        sectionHeading("Saved Queries") +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<select id="' + prefix + '-saved-select" style="flex:1"></select>' +
          '<button class="btn btn-sm btn-secondary" id="' + prefix + '-load-btn">Load</button>' +
          '<button class="btn btn-sm btn-danger" id="' + prefix + '-delete-btn">Delete</button>' +
        "</div>" +
      "</div>" +
      formDivider() +
      formHtml +
      '<div style="display:flex;justify-content:flex-end;margin:0.75rem 0"><button class="btn btn-primary" id="' + prefix + '-send">Send</button></div>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
        '<input type="text" id="' + prefix + '-save-name" placeholder="Name this query to save it" style="flex:1;font-size:0.85rem">' +
        '<button class="btn btn-sm btn-secondary" id="' + prefix + '-save-btn">Save</button>' +
      "</div>" +
      '<div id="' + prefix + '-response-wrap" style="display:none;margin-top:1rem">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
          '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
          '<button class="btn btn-sm btn-secondary" id="' + prefix + '-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
        "</div>" +
        '<pre id="' + prefix + '-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
      "</div>";
  }

  // Wire Send (buildPayload returns the body, or null after toasting why not)
  // and Copy for one console.
  function wireConsoleSend(prefix, id, buildPayload) {
    document.getElementById(prefix + "-send").addEventListener("click", async function () {
      var btn = this;
      var payload = buildPayload();
      if (!payload) return;
      btn.disabled = true;
      btn.textContent = "Sending…";
      var wrap = document.getElementById(prefix + "-response-wrap");
      var pre = document.getElementById(prefix + "-response");
      try {
        var r = await window.api.post("/integrations/" + encodeURIComponent(id) + "/query", payload);
        pre.textContent = JSON.stringify(r && r.result !== undefined ? r.result : r, null, 2);
      } catch (err) {
        pre.textContent = "Error: " + err.message;
      }
      wrap.style.display = "";
      btn.disabled = false;
      btn.textContent = "Send";
    });
    document.getElementById(prefix + "-copy-btn").addEventListener("click", function () {
      var btn = this;
      copyText(document.getElementById(prefix + "-response").textContent).then(function (ok) {
        if (!ok) { toast("Copy failed", "error"); return; }
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
  }

  // "key=value" per line → { key: value }.
  function parseQueryLines(text) {
    var query = {};
    String(text || "").split("\n").forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var eq = t.indexOf("=");
      if (eq < 0) { query[t] = ""; return; }
      var key = t.slice(0, eq).trim();
      if (key) query[key] = t.slice(eq + 1).trim();
    });
    return query;
  }

  var CONSOLE_FIELD = 'style="font-family:monospace;font-size:0.82rem"';
  var LABEL_NOTE = 'style="font-size:0.8rem;color:var(--color-text-tertiary)"';

  function openQueryConsole(intg) {
    var c = intg.config || {};
    if (intg.type === "fortimanager") openFmgQueryModal(intg.id, c.adom || "root", c.useProxy !== false);
    else if (intg.type === "fortigate") openFgtQueryModal(intg.id, c.vdom || "root");
    else if (intg.type === "entraid") openEntraQueryModal(intg.id);
    else if (intg.type === "activedirectory") openAdQueryModal(intg.id);
  }

  // ── FortiManager ──
  var FMG_PRESETS = [
    { name: "System status", mode: "fmg", params: '[\n  { "url": "/sys/status" }\n]' },
    { name: "List ADOMs", mode: "fmg", params: '[\n  {\n    "url": "/dvmdb/adom",\n    "fields": ["name", "state", "os_ver"]\n  }\n]' },
    { name: "List devices in ADOM", mode: "fmg", params: '[\n  {\n    "url": "/dvmdb/adom/<adom>/device",\n    "fields": ["name", "sn", "ip", "os_ver", "platform_str", "ha_mode", "conn_status"]\n  }\n]' },
    { name: "Charon address groups (ADOM)", mode: "fmg", params: '[\n  {\n    "url": "/pm/config/adom/<adom>/obj/firewall/addrgrp",\n    "filter": ["name", "like", "charon-%"]\n  }\n]' },
    { name: "Charon addresses (ADOM)", mode: "fmg", params: '[\n  {\n    "url": "/pm/config/adom/<adom>/obj/firewall/address",\n    "filter": ["name", "like", "charon-%"]\n  }\n]' },
    { name: "Policy packages", mode: "fmg", params: '[\n  { "url": "/pm/pkg/adom/<adom>" }\n]' },
    { name: "System status", mode: "fortigate", path: "/api/v2/monitor/system/status", query: "vdom=root" },
    { name: "Interface IPs", mode: "fortigate", path: "/api/v2/cmdb/system/interface", query: "vdom=root\nformat=name|ip|vdom|type|status" },
    { name: "Charon address groups", mode: "fortigate", path: "/api/v2/cmdb/firewall/addrgrp", query: "vdom=root\nfilter=name=@charon-" },
    { name: "Charon addresses", mode: "fortigate", path: "/api/v2/cmdb/firewall/address", query: "vdom=root\nfilter=name=@charon-" },
    { name: "Firewall policies", mode: "fortigate", path: "/api/v2/cmdb/firewall/policy", query: "vdom=root\nformat=policyid|name|srcaddr|dstaddr|action|status" },
  ];
  var fmgStore = makeSavedQueryStore("charon-fmg-queries", 1, FMG_PRESETS);

  function openFmgQueryModal(id, adom, useProxy) {
    var formHtml =
      '<div style="margin-bottom:0.75rem">' +
        sectionHeading("Query Mode") +
        '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
          '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal"><input type="radio" name="fmg-mode" value="fmg" id="fmg-mode-fmg" checked style="width:auto"> FortiManager (JSON-RPC get)</label>' +
          '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal"' + (useProxy ? ' title="Available when the integration is in direct mode"' : "") + '><input type="radio" name="fmg-mode" value="fortigate" id="fmg-mode-fgt" style="width:auto"' + (useProxy ? " disabled" : "") + "> Directly to a FortiGate (REST GET)</label>" +
        "</div>" +
        '<p class="hint" style="margin-top:0.4rem">' + (useProxy
          ? "This integration uses the FortiManager proxy, so querying a FortiGate directly is off. Turn on Direct Mode to use it."
          : "Read-only: FortiManager JSON-RPC <code>get</code>, or a FortiOS <code>GET</code> on one managed FortiGate.") + "</p>" +
      "</div>" +
      '<div id="fmg-form-fmg">' +
        '<div class="form-group"><label>Params <span ' + LABEL_NOTE + '>(JSON array, method <code>get</code>)</span></label>' +
          '<textarea id="fmg-params" rows="9" ' + CONSOLE_FIELD + ">" + esc(FMG_PRESETS[2].params.replace(/<adom>/g, adom)) + "</textarea></div>" +
      "</div>" +
      '<div id="fmg-form-fgt" style="display:none">' +
        '<div class="form-group"><label>Path <span ' + LABEL_NOTE + '>(GET)</span></label><input type="text" id="fmg-fgt-path" value="/api/v2/monitor/system/status" ' + CONSOLE_FIELD + "></div>" +
        '<div class="form-group"><label>Target FortiGate</label><input type="text" id="fmg-fgt-device" placeholder="FortiManager device name — e.g. FG-HQ-01">' +
          "<p class=\"hint\">Name as it appears in FortiManager. Charon resolves its management IP through FortiManager, then sends the GET directly with the integration's FortiGate API token.</p></div>" +
        '<div class="form-group"><label>Query Parameters <span ' + LABEL_NOTE + ">(one per line — <code>key=value</code>)</span></label>" +
          '<textarea id="fmg-fgt-query" rows="4" ' + CONSOLE_FIELD + ' placeholder="vdom=root&#10;format=name|ip">vdom=root</textarea></div>' +
      "</div>";
    openModal("FortiManager API Query", consoleHTML("fmg", formHtml), '<button class="btn btn-secondary" data-close>Close</button>', { wide: true });

    var fmgRadio = document.getElementById("fmg-mode-fmg");
    var fgtRadio = document.getElementById("fmg-mode-fgt");
    function mode() { return fgtRadio.checked ? "fortigate" : "fmg"; }
    var deviceKey = "charon-fmg-query-device-" + id;
    try {
      var last = localStorage.getItem(deviceKey);
      if (last) document.getElementById("fmg-fgt-device").value = last;
    } catch (_) { /* private mode */ }

    var consoleApi = wireSavedQueryConsole(fmgStore, "fmg",
      function () {
        return mode() === "fortigate"
          ? { mode: "fortigate", path: val("fmg-fgt-path"), deviceName: val("fmg-fgt-device"), query: document.getElementById("fmg-fgt-query").value }
          : { mode: "fmg", params: document.getElementById("fmg-params").value.trim() };
      },
      function (q) {
        if (q.mode === "fortigate") {
          if (fgtRadio.disabled) { toast("This saved query targets a FortiGate directly — turn on Direct Mode on the integration to use it", "error"); return; }
          fgtRadio.checked = true; applyMode();
          document.getElementById("fmg-fgt-path").value = q.path || "";
          // Presets carry no device: keep the one the operator typed.
          if (q.deviceName) document.getElementById("fmg-fgt-device").value = q.deviceName;
          document.getElementById("fmg-fgt-query").value = q.query || "";
        } else {
          fmgRadio.checked = true; applyMode();
          document.getElementById("fmg-params").value = String(q.params || "").replace(/<adom>/g, adom);
        }
      },
      function () { var m = mode(); return function (q) { return (q.mode === "fortigate" ? "fortigate" : "fmg") === m; }; });

    function applyMode() {
      var m = mode();
      document.getElementById("fmg-form-fmg").style.display = m === "fmg" ? "" : "none";
      document.getElementById("fmg-form-fgt").style.display = m === "fortigate" ? "" : "none";
      consoleApi.rerender(document.getElementById("fmg-saved-select").value);
    }
    fmgRadio.addEventListener("change", applyMode);
    fgtRadio.addEventListener("change", applyMode);

    wireConsoleSend("fmg", id, function () {
      if (mode() === "fortigate") {
        var deviceName = val("fmg-fgt-device");
        var path = val("fmg-fgt-path");
        if (!deviceName) { toast("Enter the FortiManager device name of the FortiGate", "error"); return null; }
        if (!path) { toast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return null; }
        try { localStorage.setItem(deviceKey, deviceName); } catch (_) { /* private mode */ }
        return { mode: "fortigate", deviceName: deviceName, method: "GET", path: path, query: parseQueryLines(document.getElementById("fmg-fgt-query").value) };
      }
      var params;
      try {
        params = JSON.parse(document.getElementById("fmg-params").value.trim());
        if (!Array.isArray(params)) throw new Error("Params must be a JSON array");
      } catch (e) {
        toast("Invalid JSON: " + e.message, "error");
        return null;
      }
      return { method: "get", params: params };
    });
  }

  // ── FortiGate ──
  var FGT_PRESETS = [
    { name: "System status", path: "/api/v2/monitor/system/status", query: "vdom=root" },
    { name: "Interface IPs", path: "/api/v2/cmdb/system/interface", query: "vdom=root\nformat=name|ip|type|status|vdom" },
    { name: "Charon address groups", path: "/api/v2/cmdb/firewall/addrgrp", query: "vdom=root\nfilter=name=@charon-" },
    { name: "Charon addresses", path: "/api/v2/cmdb/firewall/address", query: "vdom=root\nfilter=name=@charon-" },
    { name: "Firewall policies", path: "/api/v2/cmdb/firewall/policy", query: "vdom=root\nformat=policyid|name|srcaddr|dstaddr|action|status" },
    { name: "ARP table", path: "/api/v2/monitor/system/arp", query: "vdom=root" },
    { name: "Routing table (IPv4)", path: "/api/v2/monitor/router/ipv4", query: "vdom=root" },
  ];
  var fgtStore = makeSavedQueryStore("charon-fgt-queries", 1, FGT_PRESETS);

  function openFgtQueryModal(id, vdom) {
    var formHtml =
      '<div class="form-group"><label>Path <span ' + LABEL_NOTE + '>(GET only)</span></label><input type="text" id="fgt-path" value="/api/v2/monitor/system/status" ' + CONSOLE_FIELD + "></div>" +
      '<div class="form-group"><label>Query Parameters <span ' + LABEL_NOTE + ">(one per line — <code>key=value</code>)</span></label>" +
        '<textarea id="fgt-query" rows="4" ' + CONSOLE_FIELD + ' placeholder="vdom=' + esc(vdom) + '&#10;format=name|ip">vdom=' + esc(vdom) + "</textarea>" +
        '<p class="hint">Add <code>format=…</code> or <code>filter=…</code> as needed — <code>filter=name=@charon-</code> lists Charon\'s objects.</p></div>';
    openModal("FortiGate API Query", consoleHTML("fgt", formHtml), '<button class="btn btn-secondary" data-close>Close</button>', { wide: true });
    wireSavedQueryConsole(fgtStore, "fgt",
      function () { return { path: val("fgt-path"), query: document.getElementById("fgt-query").value }; },
      function (q) {
        document.getElementById("fgt-path").value = q.path || "";
        document.getElementById("fgt-query").value = String(q.query || "").replace(/vdom=root/, "vdom=" + vdom);
      });
    wireConsoleSend("fgt", id, function () {
      var path = val("fgt-path");
      if (!path) { toast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return null; }
      return { method: "GET", path: path, query: parseQueryLines(document.getElementById("fgt-query").value) };
    });
  }

  // ── Entra ID / Graph ──
  var ENTRA_PRESETS = [
    { name: "Registered devices", path: "/v1.0/devices", query: "$top=25\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,accountEnabled,approximateLastSignInDateTime" },
    { name: "Managed devices (Intune)", path: "/v1.0/deviceManagement/managedDevices", query: "$top=25\n$select=id,azureADDeviceId,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName" },
    { name: "Non-compliant devices (Intune)", path: "/v1.0/deviceManagement/managedDevices", query: "$filter=complianceState eq 'noncompliant'\n$select=id,deviceName,operatingSystem,complianceState,lastSyncDateTime,userPrincipalName\n$top=25" },
    { name: "Hybrid-joined devices", path: "/v1.0/devices", query: "$filter=trustType eq 'ServerAd'\n$top=25\n$select=id,deviceId,displayName,operatingSystem,onPremisesSecurityIdentifier" },
    { name: "Users (summary)", path: "/v1.0/users", query: "$top=25\n$select=id,displayName,userPrincipalName,accountEnabled,department" },
    { name: "Groups", path: "/v1.0/groups", query: "$top=25\n$select=id,displayName,groupTypes,securityEnabled,membershipRule" },
    { name: "Group members (edit the group id)", path: "/v1.0/groups/<group-id>/members", query: "$top=50\n$select=id,displayName,userPrincipalName" },
  ];
  var entraStore = makeSavedQueryStore("charon-entra-queries", 1, ENTRA_PRESETS);

  function openEntraQueryModal(id) {
    var formHtml =
      '<div class="form-group"><label>Path <span ' + LABEL_NOTE + ">(GET only — must begin with <code>/v1.0/</code> or <code>/beta/</code>)</span></label>" +
        '<input type="text" id="entra-path" value="/v1.0/devices" ' + CONSOLE_FIELD + "></div>" +
      '<div class="form-group"><label>Query Parameters <span ' + LABEL_NOTE + ">(one per line — <code>key=value</code>)</span></label>" +
        '<textarea id="entra-query" rows="5" ' + CONSOLE_FIELD + ' placeholder="$top=10&#10;$select=id,displayName">$top=25</textarea>' +
        '<p class="hint">Common: <code>$select</code> to limit fields, <code>$filter</code> to narrow, <code>$top</code> to cap rows. The host is fixed to <code>graph.microsoft.com</code>.</p></div>';
    openModal("Entra ID / Graph API Query", consoleHTML("entra", formHtml), '<button class="btn btn-secondary" data-close>Close</button>', { wide: true });
    wireSavedQueryConsole(entraStore, "entra",
      function () { return { path: val("entra-path"), query: document.getElementById("entra-query").value }; },
      function (q) {
        document.getElementById("entra-path").value = q.path || "";
        document.getElementById("entra-query").value = q.query || "";
      });
    wireConsoleSend("entra", id, function () {
      var path = val("entra-path");
      if (!/^\/(v1\.0|beta)\//.test(path)) { toast("The path must begin with /v1.0/ or /beta/", "error"); return null; }
      return { path: path, query: parseQueryLines(document.getElementById("entra-query").value) };
    });
  }

  // ── Active Directory / LDAP ──
  var AD_PRESETS = [
    { name: "All computers (summary)", filter: "(&(objectCategory=computer)(objectClass=computer))", attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, userAccountControl, lastLogonTimestamp", sizeLimit: "50" },
    { name: "Disabled computer accounts", filter: "(&(objectCategory=computer)(objectClass=computer)(userAccountControl:1.2.840.113556.1.4.803:=2))", attributes: "cn, dNSHostName, userAccountControl, distinguishedName", sizeLimit: "50" },
    { name: "Computer by hostname (edit cn=)", filter: "(&(objectCategory=computer)(cn=HOSTNAME*))", attributes: "cn, dNSHostName, distinguishedName, operatingSystem, objectGUID, objectSid, userAccountControl, lastLogonTimestamp", sizeLimit: "10" },
    { name: "User accounts (summary)", filter: "(&(objectCategory=person)(objectClass=user))", attributes: "sAMAccountName, userPrincipalName, displayName, userAccountControl, memberOf, distinguishedName", sizeLimit: "50" },
    { name: "Security groups", filter: "(&(objectClass=group)(groupType:1.2.840.113556.1.4.803:=2147483648))", attributes: "cn, distinguishedName, description, member", sizeLimit: "50" },
    { name: "All OUs (directory structure)", filter: "(objectClass=organizationalUnit)", attributes: "ou, distinguishedName, description", sizeLimit: "200" },
  ];
  var adStore = makeSavedQueryStore("charon-ad-queries", 1, AD_PRESETS);

  function openAdQueryModal(id) {
    var formHtml =
      '<div class="form-group"><label>Filter <span ' + LABEL_NOTE + ">(LDAP search filter)</span></label>" +
        '<input type="text" id="ad-filter" value="' + esc(AD_PRESETS[0].filter) + '" ' + CONSOLE_FIELD + "></div>" +
      '<div class="form-group"><label>Attributes <span ' + LABEL_NOTE + ">(comma-separated; empty for all)</span></label>" +
        '<input type="text" id="ad-attributes" value="' + esc(AD_PRESETS[0].attributes) + '" ' + CONSOLE_FIELD + "></div>" +
      '<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end">' +
        '<div class="form-group" style="margin-bottom:0"><label>Base DN override <span ' + LABEL_NOTE + '>(optional)</span></label><input type="text" id="ad-basedn" placeholder="Defaults to the integration base DN" ' + CONSOLE_FIELD + "></div>" +
        '<div class="form-group" style="margin-bottom:0"><label>Scope</label><select id="ad-scope" style="width:auto">' +
          '<option value="sub" selected>Subtree</option><option value="one">One level</option><option value="base">Base only</option></select></div>' +
        '<div class="form-group" style="margin-bottom:0"><label>Limit</label><input type="number" id="ad-sizelimit" value="50" min="1" max="500" style="width:70px"></div>' +
      "</div>";
    openModal("Active Directory LDAP Query", consoleHTML("ad", formHtml), '<button class="btn btn-secondary" data-close>Close</button>', { wide: true });
    wireSavedQueryConsole(adStore, "ad",
      function () { return { filter: val("ad-filter"), attributes: document.getElementById("ad-attributes").value, sizeLimit: val("ad-sizelimit") }; },
      function (q) {
        document.getElementById("ad-filter").value = q.filter || "";
        document.getElementById("ad-attributes").value = q.attributes || "";
        if (q.sizeLimit) document.getElementById("ad-sizelimit").value = q.sizeLimit;
      });
    wireConsoleSend("ad", id, function () {
      var filter = val("ad-filter");
      if (!filter) { toast("Enter a filter (e.g. (&(objectCategory=computer)(objectClass=computer)))", "error"); return null; }
      var attrs = document.getElementById("ad-attributes").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var limit = parseInt(val("ad-sizelimit"), 10);
      var body = { filter: filter, scope: val("ad-scope") || "sub", sizeLimit: limit >= 1 && limit <= 500 ? limit : 50 };
      if (attrs.length) body.attributes = attrs;
      var baseDn = val("ad-basedn");
      if (baseDn) body.baseDn = baseDn;
      return body;
    });
  }
})();
