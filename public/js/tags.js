/**
 * public/js/tags.js — Tags & Policies page.
 */
(function () {
  "use strict";
  var canWrite = false;
  var srcTagId = null;

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      canWrite = window.Charon.can("tags", "write");
      if (!canWrite) { document.getElementById("addTagBtn").style.display = "none"; document.getElementById("reconcileBtn").style.display = "none"; }
      document.getElementById("addTagBtn").addEventListener("click", addTag);
      document.getElementById("reconcileBtn").addEventListener("click", reconcile);
      wireSrcModal();
      load();
    });
  });

  function load() {
    window.api.get("/tags").then(function (data) {
      var body = document.getElementById("tagsBody");
      if (!data.tags.length) { body.innerHTML = '<tr><td colspan="6" class="muted">No tags yet.</td></tr>'; return; }
      body.innerHTML = data.tags.map(rowHtml).join("");
      data.tags.forEach(wireRow);
    });
  }

  function srcLabel(s) {
    if (s.kind === "posture") return "posture=" + s.ref;
    if (s.kind === "custom_group") return "custom group";
    return s.kind.replace("directory_", "") + ": " + s.ref;
  }

  function rowHtml(t) {
    var sources = (t.sources || []).map(function (s) {
      return '<span class="badge" data-src="' + s.id + '">' + window.Charon.escapeHtml(srcLabel(s)) +
        (canWrite ? ' <a href="#" data-rmsrc="' + s.id + '">×</a>' : "") + "</span>";
    }).join(" ") || '<span class="muted">none</span>';
    var actions = canWrite
      ? '<button class="btn btn-sm" data-addsrc="' + t.id + '" data-name="' + window.Charon.escapeHtml(t.name) + '">+ source</button> ' +
        '<button class="btn btn-sm" data-deltag="' + t.id + '">Delete</button>'
      : "";
    return "<tr>" +
      "<td><strong>" + window.Charon.escapeHtml(t.name) + "</strong></td>" +
      "<td>" + sources + "</td>" +
      "<td>" + (t._count ? t._count.endpointTags : 0) + "</td>" +
      "<td>" + (t._count ? t._count.policies : 0) + "</td>" +
      "<td>" + (t.enabled ? '<span class="badge badge-info">enabled</span>' : '<span class="badge">disabled</span>') + "</td>" +
      "<td>" + actions + "</td></tr>";
  }

  function wireRow(t) {
    document.querySelectorAll('[data-addsrc="' + t.id + '"]').forEach(function (b) {
      b.addEventListener("click", function () { openSrcModal(t.id, b.getAttribute("data-name")); });
    });
    document.querySelectorAll('[data-deltag="' + t.id + '"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("Delete tag?")) return;
        window.api.del("/tags/" + t.id).then(load).catch(err);
      });
    });
    document.querySelectorAll("[data-rmsrc]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        window.api.del("/tags/sources/" + a.getAttribute("data-rmsrc")).then(load).catch(err);
      });
    });
  }

  function addTag() {
    var name = prompt("Tag name (letters, digits, hyphen, underscore):");
    if (!name) return;
    window.api.post("/tags", { name: name }).then(load).catch(err);
  }

  function reconcile() {
    window.api.post("/tags/reconcile").then(function (r) {
      window.Charon.toast("Reconciled " + r.endpoints + " endpoints", "success");
    }).catch(err);
  }

  // ─── Source modal ──────────────────────────────────────────────────────────
  function wireSrcModal() {
    var kind = document.getElementById("srcKind");
    kind.addEventListener("change", syncSrcFields);
    document.getElementById("srcCancel").addEventListener("click", function () { document.getElementById("srcModal").hidden = true; });
    document.getElementById("srcSave").addEventListener("click", saveSrc);
  }

  function syncSrcFields() {
    var k = document.getElementById("srcKind").value;
    document.getElementById("srcRefGroup").hidden = (k === "custom_group" || k === "posture");
    document.getElementById("srcCustomGroup").hidden = (k !== "custom_group");
    document.getElementById("srcPosture").hidden = (k !== "posture");
  }

  function openSrcModal(tagId, name) {
    srcTagId = tagId;
    document.getElementById("srcTagName").textContent = name;
    document.getElementById("srcError").hidden = true;
    document.getElementById("srcRef").value = "";
    window.api.get("/groups").then(function (data) {
      document.getElementById("srcCustom").innerHTML = (data.groups || []).map(function (g) {
        return '<option value="' + g.id + '">' + window.Charon.escapeHtml(g.name) + "</option>";
      }).join("");
    });
    syncSrcFields();
    document.getElementById("srcModal").hidden = false;
  }

  function saveSrc() {
    var k = document.getElementById("srcKind").value;
    var payload = { kind: k };
    if (k === "custom_group") payload.customGroupId = document.getElementById("srcCustom").value;
    else if (k === "posture") payload.ref = document.getElementById("srcPostureSel").value;
    else payload.ref = document.getElementById("srcRef").value;
    window.api.post("/tags/" + srcTagId + "/sources", payload).then(function () {
      document.getElementById("srcModal").hidden = true;
      load();
    }).catch(function (e) { var el = document.getElementById("srcError"); el.textContent = e.message; el.hidden = false; });
  }

  function err(e) { window.Charon.toast(e.message, "error"); }
})();
