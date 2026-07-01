/**
 * public/js/groups.js — Custom group builder.
 */
(function () {
  "use strict";
  var canWrite = false;
  var editing = null;

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      canWrite = window.Charon.can("groups", "write");
      if (!canWrite) document.getElementById("addBtn").style.display = "none";
      document.getElementById("addBtn").addEventListener("click", function () { openModal(null); });
      var close = function () { document.getElementById("modal").classList.remove("open"); };
      document.getElementById("cancelBtn").addEventListener("click", close);
      document.getElementById("cancelBtn2").addEventListener("click", close);
      document.getElementById("saveBtn").addEventListener("click", save);
      load();
    });
  });

  function load() {
    window.api.get("/groups").then(function (data) {
      var body = document.getElementById("groupsBody");
      if (!data.groups.length) { body.innerHTML = '<tr><td colspan="5" class="empty-state">No groups yet.</td></tr>'; return; }
      body.innerHTML = data.groups.map(rowHtml).join("");
      data.groups.forEach(function (g) {
        previewCount(g.id);
        if (canWrite) {
          document.querySelector('[data-edit="' + g.id + '"]').addEventListener("click", function () { openModal(g); });
          document.querySelector('[data-del="' + g.id + '"]').addEventListener("click", function () {
            if (confirm("Delete group?")) window.api.del("/groups/" + g.id).then(load).catch(err);
          });
        }
      });
    });
  }

  function rowHtml(g) {
    var ruleCount = ((g.rules && g.rules.all) || []).length + ((g.rules && g.rules.any) || []).length;
    var actions = canWrite ? '<button class="btn btn-secondary btn-sm" data-edit="' + g.id + '">Edit</button> <button class="btn btn-secondary btn-sm" data-del="' + g.id + '">Delete</button>' : "";
    return "<tr>" +
      "<td><strong>" + window.Charon.escapeHtml(g.name) + "</strong><br><span class='muted'>" + window.Charon.escapeHtml(g.description || "") + "</span></td>" +
      "<td>" + (g.members ? g.members.length : 0) + "</td>" +
      "<td>" + ruleCount + " condition(s)</td>" +
      '<td id="count_' + g.id + '" class="muted">…</td>' +
      "<td>" + actions + "</td></tr>";
  }

  function previewCount(id) {
    window.api.get("/groups/" + id + "/members").then(function (r) {
      var el = document.getElementById("count_" + id);
      if (el) el.textContent = r.count + " users";
    }).catch(function () {});
  }

  function openModal(g) {
    editing = g ? g.id : null;
    document.getElementById("modalTitle").textContent = g ? "Edit group" : "New group";
    document.getElementById("modalError").hidden = true;
    document.getElementById("gName").value = g ? g.name : "";
    document.getElementById("gDesc").value = g ? (g.description || "") : "";
    document.getElementById("gMembers").value = g ? (g.members || []).join("\n") : "";
    document.getElementById("gRules").value = g && g.rules ? JSON.stringify(g.rules, null, 2) : '{\n  "all": []\n}';
    document.getElementById("modal").classList.add("open");
  }

  function save() {
    var errEl = document.getElementById("modalError");
    errEl.hidden = true;
    var members = document.getElementById("gMembers").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    var rules;
    try { rules = JSON.parse(document.getElementById("gRules").value || "{}"); }
    catch (e) { errEl.textContent = "Rules must be valid JSON"; errEl.hidden = false; return; }
    var payload = { name: document.getElementById("gName").value, description: document.getElementById("gDesc").value, members: members, rules: rules };
    var p = editing ? window.api.put("/groups/" + editing, payload) : window.api.post("/groups", payload);
    p.then(function () { document.getElementById("modal").classList.remove("open"); load(); }).catch(function (e) { errEl.textContent = e.message; errEl.hidden = false; });
  }

  function err(e) { window.Charon.toast(e.message, "error"); }
})();
