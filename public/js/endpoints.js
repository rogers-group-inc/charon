/**
 * public/js/endpoints.js — Endpoints, agent push deployments and invitation
 * codes page.
 *
 * Deployments (GET /agent-deployments, endpoints:read) list every push
 * deployment of the agent; deploying and every row action (retry / reinstall,
 * upgrade, uninstall, delete record) need endpoints:FULLWRITE (business rule
 * 12) — they run installers as root / Administrator on the host. The deploy
 * modal follows polaris's openBulkAgentDeployModal (assets.js), against
 * Charon's targets + transport + credential API.
 */
(function () {
  "use strict";
  var canWrite = false, canInvite = false, canDeploy = false;

  // Polaris badge variants (styles.css).
  var POSTURE_BADGE = { compliant: "badge-available", noncompliant: "badge-conflict", unknown: "" };
  var STATUS_BADGE = { online: "badge-active", offline: "badge-maintenance", enrolled: "badge-monitor", pending: "", revoked: "badge-conflict" };

  var DEP_BADGE = {
    pending: "badge-info", uploading: "badge-info", enrolling: "badge-warning", active: "badge-active",
    failed: "badge-conflict", upgrading: "badge-info", upgrade_failed: "badge-conflict",
    uninstalling: "badge-info", uninstalled: "badge-deprecated",
  };
  var DEP_LABEL = {
    pending: "pending", uploading: "uploading", enrolling: "awaiting enrollment", active: "active",
    failed: "failed", upgrading: "upgrading", upgrade_failed: "upgrade failed",
    uninstalling: "uninstalling", uninstalled: "uninstalled",
  };
  var OS_LABEL = { windows: "Windows", linux: "Linux", darwin: "macOS" };
  // A run is in flight: poll fast. "enrolling" means installed and awaiting the
  // agent's own enrollment, which can last indefinitely — poll it slowly.
  var DEP_RUNNING = ["pending", "uploading", "upgrading", "uninstalling"];
  var DEP_LOCKED = ["uploading", "upgrading", "uninstalling"];   // server refuses actions (409)
  var depPollTimer = null;
  var depSignature = null;

  function openModal() { document.getElementById("inviteModal").classList.add("open"); }
  function closeModal() { document.getElementById("inviteModal").classList.remove("open"); }

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      canWrite = window.Charon.can("endpoints", "write");
      canInvite = window.Charon.can("invitationCodes", "write");
      canDeploy = window.Charon.can("endpoints", "fullwrite");
      if (!canInvite) document.getElementById("inviteBtn").style.display = "none";
      if (canDeploy) document.getElementById("deployBtn").style.display = "";
      wireInviteModal();
      wireDeployModal();
      wireDeploymentActions();
      loadEndpoints();
      loadDeployments();
      loadInvites();
    });
  });

  function loadEndpoints() {
    window.api.get("/endpoints").then(function (data) {
      var body = document.getElementById("epBody");
      if (!data.endpoints.length) { body.innerHTML = '<tr><td colspan="8" class="empty-state">No endpoints enrolled yet. Create an invitation code to enroll an agent.</td></tr>'; return; }
      body.innerHTML = data.endpoints.map(epRow).join("");
      if (canWrite) data.endpoints.forEach(function (e) {
        var b = document.querySelector('[data-revoke="' + e.id + '"]');
        if (b) b.addEventListener("click", function () {
          if (confirm("Revoke this endpoint? Its agent will be locked out.")) {
            window.api.post("/endpoints/" + e.id + "/revoke").then(loadEndpoints).catch(err);
          }
        });
      });
    });
  }

  function epRow(e) {
    var esc = window.Charon.escapeHtml;
    var tags = (e.tags || []).map(function (t) { return '<span class="badge badge-monitor">' + esc(t) + "</span>"; }).join(" ") || '<span class="muted">—</span>';
    var revoke = canWrite && e.status !== "revoked" ? '<button class="btn btn-secondary btn-sm" data-revoke="' + e.id + '">Revoke</button>' : "";
    return '<tr id="ep-' + esc(e.id) + '">' +
      "<td>" + esc(e.hostname || e.id.slice(0, 8)) + "<br><span class='muted'>" + esc(e.osPlatform || "") + " " + esc(e.osVersion || "") + "</span></td>" +
      '<td><span class="badge ' + (STATUS_BADGE[e.status] || "") + '">' + e.status + "</span></td>" +
      "<td>" + esc(e.boundUserName || "—") + "</td>" +
      "<td>" + esc(e.currentIp || "—") + "<br><span class='muted'>" + esc(e.currentMac || "") + "</span></td>" +
      '<td><span class="badge ' + (POSTURE_BADGE[e.postureState] || "") + '">' + e.postureState + "</span></td>" +
      "<td>" + tags + "</td>" +
      "<td>" + (e.lastSeenAt ? new Date(e.lastSeenAt).toLocaleString() : "—") + "</td>" +
      "<td>" + revoke + "</td></tr>";
  }

  // ─── Deployments ──────────────────────────────────────────────────────────

  function loadDeployments() {
    if (depPollTimer) { clearTimeout(depPollTimer); depPollTimer = null; }
    window.api.get("/agent-deployments").then(function (data) {
      var rows = data.deployments || [];
      var body = document.getElementById("depBody");
      body.innerHTML = rows.length
        ? rows.map(depRow).join("")
        : '<tr><td colspan="9" class="empty-state">No push deployments yet.' +
          (canDeploy ? " Use Deploy agent to install the agent on hosts over SSH or WinRM." : "") + "</td></tr>";

      // A status change (e.g. an agent enrolled) can add or update an endpoint.
      var sig = rows.map(function (d) { return d.id + ":" + d.status; }).join("|");
      if (depSignature !== null && sig !== depSignature) loadEndpoints();
      depSignature = sig;

      var running = rows.some(function (d) { return DEP_RUNNING.indexOf(d.status) >= 0; });
      var enrolling = rows.some(function (d) { return d.status === "enrolling"; });
      if (running) depPollTimer = setTimeout(loadDeployments, 5000);
      else if (enrolling) depPollTimer = setTimeout(loadDeployments, 30000);
    }).catch(function (e) {
      document.getElementById("depBody").innerHTML = '<tr><td colspan="9" class="empty-state">' +
        window.Charon.escapeHtml(e.status === 403 ? "No access." : "Could not load deployments: " + e.message) + "</td></tr>";
    });
  }

  function depRow(d) {
    var esc = window.Charon.escapeHtml;
    var when = function (t) { return t ? new Date(t).toLocaleString() : "—"; };
    var cred = d.credential ? esc(d.credential.name) : '<span class="muted">(deleted)</span>';
    var ep = d.endpoint
      ? '<a href="#ep-' + esc(d.endpoint.id) + '">' + esc(d.endpoint.hostname || d.endpoint.id.slice(0, 8)) + "</a>" +
        '<br><span class="muted">' + esc(d.endpoint.status) + "</span>"
      : '<span class="muted">—</span>';
    var agent = d.agentVersion ? esc(d.agentVersion) : "—";
    if (d.endpoint && d.endpoint.agentVersion && d.endpoint.agentVersion !== d.agentVersion) {
      agent += '<br><span class="muted">reports ' + esc(d.endpoint.agentVersion) + "</span>";
    }
    var lastErr = d.lastError
      ? '<span title="' + esc(d.lastError) + '" style="color:var(--color-danger);display:inline-block;max-width:22rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">' +
        esc(d.lastError) + "</span>"
      : '<span class="muted">—</span>';
    return "<tr>" +
      "<td>" + esc(d.host) + "</td>" +
      "<td>" + esc(OS_LABEL[d.osPlatform] || d.osPlatform) + (d.arch ? ' <span class="muted">' + esc(d.arch) + "</span>" : "") +
        '<br><span class="muted">' + esc(d.transport === "winrm" ? "WinRM" : "SSH") + "</span></td>" +
      "<td>" + cred + "</td>" +
      '<td><span class="badge ' + (DEP_BADGE[d.status] || "") + '">' + esc(DEP_LABEL[d.status] || d.status) + "</span></td>" +
      "<td>" + agent + "</td>" +
      "<td>" + ep + "</td>" +
      "<td>" + lastErr + "</td>" +
      "<td>" + when(d.lastAttemptAt) + "</td>" +
      '<td style="white-space:nowrap">' + depActions(d) + "</td></tr>";
  }

  function depActions(d) {
    if (!canDeploy) return "";
    var esc = window.Charon.escapeHtml;
    var s = d.status;
    var b = function (act, label) {
      return '<button class="btn btn-secondary btn-sm" data-dep-act="' + act + '" data-dep-id="' + esc(d.id) +
        '" data-dep-host="' + esc(d.host) + '">' + label + "</button> ";
    };
    var out = "";
    if (s === "failed") out += b("retry", "Retry");
    if (s === "active" || s === "uninstalled") out += b("retry", "Reinstall");
    if (s === "active" || s === "upgrade_failed") out += b("upgrade", "Upgrade");
    if (DEP_LOCKED.indexOf(s) < 0 && s !== "uninstalled") out += b("uninstall", "Uninstall");
    if (DEP_LOCKED.indexOf(s) < 0) out += b("delete", "Delete record");
    return out;
  }

  // One delegated handler for every row action (the tbody is re-rendered on
  // each poll, so per-button listeners would have to be re-bound each time).
  function wireDeploymentActions() {
    document.getElementById("depBody").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-dep-act]") : null;
      if (!btn || !canDeploy) return;
      var act = btn.getAttribute("data-dep-act");
      var id = btn.getAttribute("data-dep-id");
      var host = btn.getAttribute("data-dep-host");
      var path = "/agent-deployments/" + encodeURIComponent(id);
      var msg, call, done;
      if (act === "retry") {
        msg = (btn.textContent === "Retry" ? "Retry the install on " : "Reinstall the agent on ") + host + "?\n\n" +
          "Charon connects with the deployment's credential and runs the installer as root / Administrator, with a fresh " +
          "single-use enrollment code.";
        call = function () { return window.api.post(path + "/retry", {}); };
        done = "Install started on " + host;
      } else if (act === "upgrade") {
        msg = "Upgrade the agent on " + host + " to the current installer version?\n\n" +
          "Charon connects with the deployment's credential and runs the installer as root / Administrator. The agent keeps " +
          "its bearer and certificate pins.";
        call = function () { return window.api.post(path + "/upgrade", {}); };
        done = "Upgrade started on " + host;
      } else if (act === "uninstall") {
        msg = "Uninstall the agent from " + host + "?\n\n" +
          "Charon connects with the deployment's credential, removes the agent, and revokes the endpoint's bearer — the " +
          "endpoint loses its access tags.";
        call = function () { return window.api.post(path + "/uninstall", {}); };
        done = "Uninstall started on " + host;
      } else if (act === "delete") {
        msg = "Delete the deployment record for " + host + "?\n\n" +
          "Only the record is removed — an agent installed on the host stays installed and enrolled. Use Uninstall to " +
          "remove it from the host.";
        call = function () { return window.api.del(path); };
        done = "Deployment record deleted";
      } else {
        return;
      }
      if (!confirm(msg)) return;
      btn.disabled = true;
      call().then(function () {
        window.Charon.toast(done, "success");
        loadDeployments();
      }).catch(function (e2) { btn.disabled = false; err(e2); });
    });
  }

  // ─── Deploy modal ─────────────────────────────────────────────────────────

  var credentials = null;        // [{id,name,type}] once loaded; [] when not readable
  var credError = null;
  var devices = [];              // the last directory query's device rows
  var picked = {};               // directoryObjectId -> { host, osPlatform, directoryObjectId }
  var paneMode = "manual";
  var devQueryTimer = null;
  var devQuerySeq = 0;
  var deviceKindParamOk = true;  // false once /directory refuses kind=device

  function $(id) { return document.getElementById(id); }

  function openDeploy() {
    $("deployForm").hidden = false;
    $("deployResult").hidden = true;
    $("deployResult").innerHTML = "";
    $("deployError").hidden = true;
    $("deployGo").style.display = "";
    $("deployGo").disabled = false;
    $("deployCancel").textContent = "Cancel";
    $("dHosts").value = "";
    $("dFilter").value = "";
    picked = {};
    setPane("manual");
    $("deployModal").classList.add("open");
    loadCredentials();
  }

  function closeDeploy() { $("deployModal").classList.remove("open"); }

  function wireDeployModal() {
    $("deployBtn").addEventListener("click", function () { if (canDeploy) openDeploy(); });
    $("deployClose").addEventListener("click", closeDeploy);
    $("deployCancel").addEventListener("click", closeDeploy);
    $("deployGo").addEventListener("click", submitDeploy);
    $("dTabManual").addEventListener("click", function () { setPane("manual"); });
    $("dTabDiscovered").addEventListener("click", function () { setPane("discovered"); });
    $("dTransport").addEventListener("change", function () { renderCredOptions(); updateSummary(); });
    $("dOs").addEventListener("change", updateSummary);
    $("dHosts").addEventListener("input", updateSummary);
    $("dFilter").addEventListener("input", function () {
      if (devQueryTimer) clearTimeout(devQueryTimer);
      devQueryTimer = setTimeout(queryDevices, 300);
    });
    $("dDevAll").addEventListener("change", function () {
      var on = $("dDevAll").checked;
      Array.prototype.forEach.call(document.querySelectorAll("#dDevBody input[data-dev]"), function (c) {
        if (c.disabled) return;
        c.checked = on;
        togglePick(c.getAttribute("data-dev"), on);
      });
      updateSummary();
    });
    $("dDevBody").addEventListener("change", function (e) {
      var c = e.target;
      if (!c || !c.getAttribute || !c.getAttribute("data-dev")) return;
      togglePick(c.getAttribute("data-dev"), c.checked);
      updateSummary();
    });
  }

  function setPane(mode) {
    paneMode = mode;
    $("dPaneManual").hidden = mode !== "manual";
    $("dPaneDiscovered").hidden = mode !== "discovered";
    $("dTabManual").className = "btn btn-sm " + (mode === "manual" ? "btn-primary" : "btn-secondary");
    $("dTabDiscovered").className = "btn btn-sm " + (mode === "discovered" ? "btn-primary" : "btn-secondary");
    if (mode === "discovered") queryDevices();
    updateSummary();
  }

  function loadCredentials() {
    if (credentials) { renderCredOptions(); return; }
    if (!window.Charon.can("credentials", "read")) {
      credentials = [];
      credError = "Choosing a credential needs read access to Credentials.";
      renderCredOptions();
      return;
    }
    $("dCred").innerHTML = '<option value="">Loading…</option>';
    window.api.get("/credentials").then(function (list) {
      credentials = (Array.isArray(list) ? list : []).filter(function (c) { return c.type === "ssh" || c.type === "winrm"; });
      credError = null;
      renderCredOptions();
    }).catch(function (e) {
      credentials = null;   // retry on the next open
      credError = "Could not load credentials: " + e.message;
      renderCredOptions();
    });
  }

  function renderCredOptions() {
    var esc = window.Charon.escapeHtml;
    var transport = $("dTransport").value;
    var list = (credentials || []).filter(function (c) { return c.type === transport; });
    var sel = $("dCred");
    var prev = sel.value;
    sel.innerHTML = list.length
      ? '<option value="">Choose a credential</option>' + list.map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>";
        }).join("")
      : '<option value="">No ' + (transport === "winrm" ? "WinRM" : "SSH") + " credentials</option>";
    if (prev && list.some(function (c) { return c.id === prev; })) sel.value = prev;
    $("dCredNote").textContent = credError ||
      (transport === "ssh"
        ? "An SSH credential whose account can run the installer as root (Linux / macOS) or is a local administrator (Windows). The SSH Deployment card under Server Settings → Maintenance creates managed ones."
        : "A WinRM credential for a local administrator account. WinRM reaches Windows hosts only.");
  }

  // Map a directory device's operatingSystem to a deploy target OS. Anything
  // unrecognised (iOS, Android, blank) returns null and is not selectable —
  // Charon will not guess which installer a host needs.
  function osOf(osName) {
    var s = String(osName || "").toLowerCase();
    if (!s) return null;
    if (s.indexOf("windows") >= 0) return "windows";
    if (/mac ?os|macmdm|os x|darwin/.test(s)) return "darwin";
    if (/linux|ubuntu|debian|red ?hat|rhel|centos|fedora|suse|rocky|alma|oracle/.test(s)) return "linux";
    return null;
  }

  function deviceTarget(d) {
    var attrs = d.attributes || {};
    return { host: d.identifier || d.name, osPlatform: osOf(attrs.operatingSystem), directoryObjectId: d.id, osName: attrs.operatingSystem || "", disabled: attrs.disabled === true };
  }

  function togglePick(id, on) {
    if (!on) { delete picked[id]; return; }
    var d = devices.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    var t = deviceTarget(d);
    if (!t.osPlatform || !t.host) return;
    picked[id] = { host: t.host, osPlatform: t.osPlatform, directoryObjectId: id };
  }

  // Server-side search (q) so a large directory is never loaded whole. The
  // route caps a page at 500 rows.
  function queryDevices() {
    var body = $("dDevBody");
    if (!window.Charon.can("directory", "read")) {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">Picking discovered devices needs read access to the Directory.</td></tr>';
      return;
    }
    var q = $("dFilter").value.trim();
    var seq = ++devQuerySeq;
    var qs = "?limit=500" + (q ? "&q=" + encodeURIComponent(q) : "");
    var run = function (withKind) {
      return window.api.get("/directory" + qs + (withKind ? "&kind=device" : ""));
    };
    body.innerHTML = '<tr><td colspan="4" class="empty-state">Loading…</td></tr>';
    var p = deviceKindParamOk
      ? run(true).catch(function (e) {
          // Older servers' /directory refuses kind=device (400): fall back to
          // an unfiltered page and keep the device rows client-side.
          if (e.status !== 400) throw e;
          deviceKindParamOk = false;
          return run(false);
        })
      : run(false);
    p.then(function (data) {
      if (seq !== devQuerySeq) return;
      devices = (data.objects || []).filter(function (o) { return o.kind === "device"; });
      renderDevices(data.objects ? data.objects.length : 0);
    }).catch(function (e) {
      if (seq !== devQuerySeq) return;
      body.innerHTML = '<tr><td colspan="4" class="empty-state">' + window.Charon.escapeHtml("Could not load devices: " + e.message) + "</td></tr>";
    });
  }

  function renderDevices(rawCount) {
    var esc = window.Charon.escapeHtml;
    var body = $("dDevBody");
    $("dDevAll").checked = false;
    if (!devices.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">No discovered devices' +
        ($("dFilter").value.trim() ? " match the filter" : " — add an Active Directory, Entra ID or Intune integration") + ".</td></tr>";
    } else {
      body.innerHTML = devices.map(function (d) {
        var t = deviceTarget(d);
        var ok = !!(t.osPlatform && t.host);
        var why = !t.host ? "No hostname recorded for this device"
          : !t.osPlatform ? "The directory reports no Windows / Linux / macOS operating system for this device" : "";
        return "<tr>" +
          '<td><input type="checkbox" data-dev="' + esc(d.id) + '"' + (picked[d.id] ? " checked" : "") +
            (ok ? "" : ' disabled title="' + esc(why) + '"') + "></td>" +
          "<td>" + esc(d.name) + (t.disabled ? ' <span class="muted">(disabled)</span>' : "") + "</td>" +
          '<td style="word-break:break-all">' + esc(t.host || "—") + "</td>" +
          "<td>" + (t.osPlatform ? esc(OS_LABEL[t.osPlatform]) : '<span class="muted">' + esc(t.osName || "unknown") + "</span>") + "</td>" +
        "</tr>";
      }).join("");
    }
    var capped = rawCount >= 500;
    $("dDevNote").textContent = devices.length
      ? devices.length + " device" + (devices.length === 1 ? "" : "s") + " shown" +
        (capped ? " — the first 500 results; narrow the filter to find others" : "") +
        ". Devices without a recognised operating system cannot be selected."
      : "";
  }

  function manualTargets() {
    var os = $("dOs").value;
    return $("dHosts").value.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean).map(function (h) { return { host: h, osPlatform: os }; });
  }

  function currentTargets() {
    var list = paneMode === "manual"
      ? manualTargets()
      : Object.keys(picked).map(function (k) { return picked[k]; });
    var seen = {};
    return list.filter(function (t) {
      var k = t.host.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function updateSummary() {
    var n = currentTargets().length;
    $("dSummary").textContent = n ? n + " host" + (n === 1 ? "" : "s") + " selected." : "";
    $("deployGo").textContent = n ? "Deploy to " + n + " host" + (n === 1 ? "" : "s") : "Deploy";
  }

  function showDeployError(msg) {
    var el = $("deployError");
    el.textContent = msg;
    el.hidden = false;
  }

  function submitDeploy() {
    $("deployError").hidden = true;
    var targets = currentTargets();
    var transport = $("dTransport").value;
    var credentialId = $("dCred").value;
    if (!targets.length) return showDeployError(paneMode === "manual" ? "Enter at least one host." : "Select at least one device.");
    if (targets.length > 2000) return showDeployError("At most 2000 hosts per deployment — split the list.");
    var bad = targets.filter(function (t) { return t.host.length > 253 || /\s/.test(t.host); });
    if (bad.length) return showDeployError("Not a hostname or address: " + bad[0].host);
    if (transport === "winrm") {
      var nonWin = targets.filter(function (t) { return t.osPlatform !== "windows"; });
      if (nonWin.length) {
        return showDeployError("WinRM reaches Windows hosts only — " + nonWin.length + " selected host" +
          (nonWin.length === 1 ? " is" : "s are") + " not Windows (" + nonWin[0].host + "). Use SSH, or deploy them separately.");
      }
    }
    if (!credentialId) return showDeployError("Choose a credential.");
    var credName = $("dCred").options[$("dCred").selectedIndex].text;
    if (!confirm("Deploy the agent to " + targets.length + " host" + (targets.length === 1 ? "" : "s") + " over " +
        (transport === "winrm" ? "WinRM" : "SSH") + " as \"" + credName + "\"?\n\n" +
        "The installer runs as root / Administrator on every host.")) return;

    var btn = $("deployGo");
    btn.disabled = true;
    btn.textContent = "Starting…";
    window.api.post("/agent-deployments", {
      targets: targets.map(function (t) {
        var o = { host: t.host, osPlatform: t.osPlatform };
        if (t.directoryObjectId) o.directoryObjectId = t.directoryObjectId;
        return o;
      }),
      transport: transport,
      credentialId: credentialId,
    }).then(function (r) {
      var created = (r.created || []).length;
      var skipped = r.skipped || [];
      window.Charon.toast("Started " + created + " deployment" + (created === 1 ? "" : "s") +
        (skipped.length ? ", skipped " + skipped.length : ""), skipped.length && !created ? "error" : "success");
      loadDeployments();
      if (!skipped.length) { closeDeploy(); return; }
      renderDeployResult(created, skipped);
    }).catch(function (e) {
      btn.disabled = false;
      updateSummary();
      showDeployError(e.message);
    });
  }

  // Skipped hosts stay on screen with the server's reason for each.
  function renderDeployResult(created, skipped) {
    var esc = window.Charon.escapeHtml;
    $("deployForm").hidden = true;
    var res = $("deployResult");
    res.hidden = false;
    res.innerHTML =
      "<p style=\"margin:0 0 0.75rem\">" + (created
        ? "<strong>" + created + "</strong> deployment" + (created === 1 ? "" : "s") + " started — progress shows in the Deployments table."
        : "No deployments were started.") + "</p>" +
      '<p style="margin:0 0 0.4rem;font-weight:600">Skipped (' + skipped.length + ")</p>" +
      '<div style="max-height:300px;overflow:auto"><table style="width:100%;font-size:0.85rem">' +
        "<thead><tr><th>Host</th><th>Reason</th></tr></thead><tbody>" +
        skipped.map(function (s) {
          return '<tr><td style="white-space:nowrap;vertical-align:top">' + esc(s.host) + '</td><td style="word-break:break-word">' + esc(s.reason) + "</td></tr>";
        }).join("") +
      "</tbody></table></div>";
    $("deployGo").style.display = "none";
    $("deployCancel").textContent = "Close";
  }

  // ─── Invitation codes ─────────────────────────────────────────────────────

  function loadInvites() {
    if (!window.Charon.can("invitationCodes", "read")) { document.getElementById("invBody").innerHTML = '<tr><td colspan="6" class="empty-state">No access.</td></tr>'; return; }
    window.api.get("/endpoints/invitations").then(function (data) {
      var body = document.getElementById("invBody");
      if (!data.codes.length) { body.innerHTML = '<tr><td colspan="6" class="empty-state">No invitation codes.</td></tr>'; return; }
      body.innerHTML = data.codes.map(invRow).join("");
      if (canInvite) data.codes.forEach(function (c) {
        var b = document.querySelector('[data-revinv="' + c.id + '"]');
        if (b) b.addEventListener("click", function () { window.api.del("/endpoints/invitations/" + c.id).then(loadInvites).catch(err); });
      });
    });
  }

  function invRow(c) {
    var esc = window.Charon.escapeHtml;
    var status = c.revokedAt ? '<span class="badge badge-conflict">revoked</span>'
      : (c.expiresAt && new Date(c.expiresAt) < new Date()) ? '<span class="badge badge-maintenance">expired</span>'
      : '<span class="badge badge-active">active</span>';
    var revoke = canInvite && !c.revokedAt ? '<button class="btn btn-secondary btn-sm" data-revinv="' + c.id + '">Revoke</button>' : "";
    return "<tr>" +
      "<td>" + esc(c.label || "—") + "</td>" +
      "<td><code>" + esc(c.codePrefix) + "…</code></td>" +
      "<td>" + c.useCount + " / " + c.maxUses + "</td>" +
      "<td>" + (c.expiresAt ? new Date(c.expiresAt).toLocaleString() : "never") + "</td>" +
      "<td>" + status + "</td>" +
      "<td>" + revoke + "</td></tr>";
  }

  function wireInviteModal() {
    document.getElementById("inviteBtn").addEventListener("click", function () {
      document.getElementById("inviteResult").hidden = true;
      document.getElementById("inviteError").hidden = true;
      document.getElementById("inviteCreate").disabled = false;
      openModal();
    });
    document.getElementById("inviteClose").addEventListener("click", function () { closeModal(); loadInvites(); });
    document.getElementById("inviteClose2").addEventListener("click", function () { closeModal(); loadInvites(); });
    document.getElementById("inviteCreate").addEventListener("click", createInvite);
  }

  function createInvite() {
    var payload = { label: document.getElementById("iLabel").value || undefined, maxUses: Number(document.getElementById("iUses").value) || 1 };
    var exp = document.getElementById("iExpiry").value;
    if (exp) payload.expiresInHours = Number(exp);
    window.api.post("/endpoints/invitations", payload).then(function (r) {
      document.getElementById("inviteCode").textContent = r.plaintext;
      document.getElementById("inviteResult").hidden = false;
      document.getElementById("inviteCreate").disabled = true;
    }).catch(function (e) { var el = document.getElementById("inviteError"); el.textContent = e.message; el.hidden = false; });
  }

  function err(e) { window.Charon.toast(e.message, "error"); }
})();
