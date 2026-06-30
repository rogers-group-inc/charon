/**
 * public/js/integrations.js — Integrations page.
 *
 * Cards per integration (status, last test/sync, configure/test/discover),
 * plus a data-driven configure modal whose fields come from TYPE_FIELDS. The
 * server masks secrets, so secret inputs show a placeholder and an empty submit
 * preserves the stored value.
 */
(function () {
  "use strict";

  var TYPE_LABELS = {
    fortimanager: "FortiManager", fortigate: "FortiGate",
    activedirectory: "Active Directory", entraid: "Entra ID", intune: "Intune",
  };
  // [name, label, type, secret?]
  var TYPE_FIELDS = {
    fortimanager: [["host", "Host", "text"], ["port", "Port", "number"], ["apiUser", "API user", "text"], ["apiToken", "API token", "password", true], ["adom", "ADOM", "text"], ["verifyTls", "Verify TLS", "checkbox"]],
    fortigate: [["host", "Host", "text"], ["port", "Port", "number"], ["apiToken", "API token", "password", true], ["vdom", "VDOM", "text"], ["verifyTls", "Verify TLS", "checkbox"]],
    activedirectory: [["host", "Host", "text"], ["port", "Port", "number"], ["baseDn", "Base DN", "text"], ["bindDn", "Bind DN", "text"], ["bindPassword", "Bind password", "password", true], ["useLdaps", "Use LDAPS", "checkbox"], ["verifyTls", "Verify TLS", "checkbox"]],
    entraid: [["tenantId", "Tenant ID", "text"], ["clientId", "Client ID", "text"], ["clientSecret", "Client secret", "password", true]],
    intune: [["tenantId", "Tenant ID", "text"], ["clientId", "Client ID", "text"], ["clientSecret", "Client secret", "password", true]],
  };
  var DIRECTORY_TYPES = { activedirectory: 1, entraid: 1 };
  var MASK = "••••••••";

  var editing = null; // integration id when editing
  var canWrite = false;

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      canWrite = window.Charon.can("integrations", "write");
      if (!canWrite) document.getElementById("addBtn").style.display = "none";
      wireModal();
      load();
    });
  });

  function load() {
    window.api.get("/integrations").then(function (data) {
      var cards = document.getElementById("cards");
      if (!data.integrations.length) {
        cards.innerHTML = '<div class="muted">No integrations yet.</div>';
        return;
      }
      cards.innerHTML = data.integrations.map(cardHtml).join("");
      data.integrations.forEach(wireCard);
    });
  }

  function statusBadge(it) {
    if (it.lastTestOk === true) return '<span class="badge badge-info">Connected</span>';
    if (it.lastTestOk === false) return '<span class="badge badge-error">Error</span>';
    return '<span class="badge">Untested</span>';
  }

  function cardHtml(it) {
    var last = it.lastTestAt ? new Date(it.lastTestAt).toLocaleString() : "never";
    var btns = canWrite
      ? '<button class="btn btn-sm" data-act="test" data-id="' + it.id + '">Test</button>' +
        (DIRECTORY_TYPES[it.type] ? ' <button class="btn btn-sm" data-act="discover" data-id="' + it.id + '">Discover</button>' : "") +
        ' <button class="btn btn-sm" data-act="edit" data-id="' + it.id + '">Edit</button>' +
        ' <button class="btn btn-sm" data-act="delete" data-id="' + it.id + '">Delete</button>'
      : "";
    return '<div class="settings-card">' +
      "<h2>" + (TYPE_LABELS[it.type] || it.type) + "</h2>" +
      "<p><strong>" + window.Charon.escapeHtml(it.name) + "</strong> " + statusBadge(it) + "</p>" +
      '<p class="muted">Last test: ' + last + "</p>" +
      '<div class="card-actions">' + btns + "</div>" +
      "</div>";
  }

  function wireCard(it) {
    document.querySelectorAll('[data-id="' + it.id + '"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        if (act === "edit") return openModal(it);
        if (act === "delete") return doDelete(it);
        if (act === "test") return doTest(btn, it.id);
        if (act === "discover") return doDiscover(btn, it.id);
      });
    });
  }

  function doTest(btn, id) {
    btn.disabled = true; btn.textContent = "Testing…";
    window.api.post("/integrations/" + id + "/test").then(function (r) {
      window.Charon.toast(r.ok ? "✓ " + r.message : "✗ " + r.message, r.ok ? "success" : "error");
      load();
    }).catch(function (e) { window.Charon.toast(e.message, "error"); btn.disabled = false; btn.textContent = "Test"; });
  }

  function doDiscover(btn, id) {
    btn.disabled = true; btn.textContent = "Discovering…";
    window.api.post("/integrations/" + id + "/discover").then(function (r) {
      var c = r.counts || {};
      window.Charon.toast("Discovered " + (c.user || 0) + " users, " + (c.group || 0) + " groups, " + (c.ou || 0) + " OUs", "success");
      btn.disabled = false; btn.textContent = "Discover";
    }).catch(function (e) { window.Charon.toast(e.message, "error"); btn.disabled = false; btn.textContent = "Discover"; });
  }

  function doDelete(it) {
    if (!confirm('Delete integration "' + it.name + '"?')) return;
    window.api.del("/integrations/" + it.id).then(load).catch(function (e) { window.Charon.toast(e.message, "error"); });
  }

  // ─── Modal ───────────────────────────────────────────────────────────────
  function wireModal() {
    var typeSel = document.getElementById("fType");
    typeSel.innerHTML = Object.keys(TYPE_FIELDS).map(function (t) {
      return '<option value="' + t + '">' + TYPE_LABELS[t] + "</option>";
    }).join("");
    typeSel.addEventListener("change", function () { renderFields(typeSel.value, {}); });
    document.getElementById("addBtn").addEventListener("click", function () { openModal(null); });
    document.getElementById("cancelBtn").addEventListener("click", closeModal);
    document.getElementById("testBtn").addEventListener("click", onTest);
    document.getElementById("cfgForm").addEventListener("submit", onSave);
  }

  function renderFields(type, values) {
    var html = (TYPE_FIELDS[type] || []).map(function (f) {
      var name = f[0], label = f[1], itype = f[2], secret = f[3];
      var id = "cfg_" + name;
      if (itype === "checkbox") {
        var checked = values[name] ? " checked" : "";
        return '<div class="form-group"><label><input type="checkbox" id="' + id + '" data-field="' + name + '"' + checked + "> " + label + "</label></div>";
      }
      var val = secret ? "" : (values[name] != null ? String(values[name]) : "");
      var ph = secret && values[name] === MASK ? ' placeholder="•••••••• (unchanged)"' : "";
      return '<div class="form-group"><label for="' + id + '">' + label + '</label><input type="' + itype + '" id="' + id + '" data-field="' + name + '" value="' + window.Charon.escapeHtml(val) + '"' + ph + "></div>";
    }).join("");
    document.getElementById("typeFields").innerHTML = html;
  }

  function openModal(it) {
    editing = it ? it.id : null;
    document.getElementById("modalTitle").textContent = it ? "Edit integration" : "Add integration";
    document.getElementById("modalError").hidden = true;
    document.getElementById("testResult").textContent = "";
    var typeSel = document.getElementById("fType");
    typeSel.value = it ? it.type : Object.keys(TYPE_FIELDS)[0];
    typeSel.disabled = !!it;
    document.getElementById("fName").value = it ? it.name : "";
    renderFields(typeSel.value, it ? it.config : {});
    document.getElementById("modal").hidden = false;
  }

  function closeModal() { document.getElementById("modal").hidden = true; }

  function collectConfig() {
    var cfg = {};
    document.querySelectorAll("#typeFields [data-field]").forEach(function (el) {
      var name = el.getAttribute("data-field");
      if (el.type === "checkbox") cfg[name] = el.checked;
      else if (el.type === "number") { if (el.value) cfg[name] = Number(el.value); }
      else if (el.value !== "") cfg[name] = el.value;
    });
    return cfg;
  }

  function onTest() {
    var out = document.getElementById("testResult");
    out.textContent = "Testing…";
    window.api.post("/integrations/test", {
      type: document.getElementById("fType").value,
      config: collectConfig(),
      existingId: editing || undefined,
    }).then(function (r) { out.textContent = (r.ok ? "✓ " : "✗ ") + r.message + (r.version ? " (" + r.version + ")" : ""); })
      .catch(function (e) { out.textContent = "✗ " + e.message; });
  }

  function onSave(e) {
    e.preventDefault();
    var err = document.getElementById("modalError");
    err.hidden = true;
    var payload = { name: document.getElementById("fName").value, config: collectConfig() };
    var p = editing
      ? window.api.put("/integrations/" + editing, payload)
      : window.api.post("/integrations", Object.assign({ type: document.getElementById("fType").value }, payload));
    p.then(function () { closeModal(); load(); }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; });
  }
})();
