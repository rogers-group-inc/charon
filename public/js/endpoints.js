/**
 * public/js/endpoints.js — Endpoints + invitation codes page.
 */
(function () {
  "use strict";
  var canWrite = false, canInvite = false;

  var POSTURE_BADGE = { compliant: "badge-info", noncompliant: "badge-error", unknown: "badge" };
  var STATUS_BADGE = { online: "badge-info", offline: "badge-warning", enrolled: "badge", pending: "badge", revoked: "badge-error" };

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      canWrite = window.Charon.can("endpoints", "write");
      canInvite = window.Charon.can("invitationCodes", "write");
      if (!canInvite) document.getElementById("inviteBtn").style.display = "none";
      wireInviteModal();
      loadEndpoints();
      loadInvites();
    });
  });

  function loadEndpoints() {
    window.api.get("/endpoints").then(function (data) {
      var body = document.getElementById("epBody");
      if (!data.endpoints.length) { body.innerHTML = '<tr><td colspan="8" class="muted">No endpoints enrolled yet. Create an invitation code to enroll an agent.</td></tr>'; return; }
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
    var tags = (e.tags || []).map(function (t) { return '<span class="badge badge-info">' + esc(t) + "</span>"; }).join(" ") || '<span class="muted">—</span>';
    var revoke = canWrite && e.status !== "revoked" ? '<button class="btn btn-sm" data-revoke="' + e.id + '">Revoke</button>' : "";
    return "<tr>" +
      "<td>" + esc(e.hostname || e.id.slice(0, 8)) + "<br><span class='muted'>" + esc(e.osPlatform || "") + " " + esc(e.osVersion || "") + "</span></td>" +
      '<td><span class="badge ' + (STATUS_BADGE[e.status] || "badge") + '">' + e.status + "</span></td>" +
      "<td>" + esc(e.boundUserName || "—") + "</td>" +
      "<td>" + esc(e.currentIp || "—") + "<br><span class='muted'>" + esc(e.currentMac || "") + "</span></td>" +
      '<td><span class="badge ' + (POSTURE_BADGE[e.postureState] || "badge") + '">' + e.postureState + "</span></td>" +
      "<td>" + tags + "</td>" +
      "<td>" + (e.lastSeenAt ? new Date(e.lastSeenAt).toLocaleString() : "—") + "</td>" +
      "<td>" + revoke + "</td></tr>";
  }

  function loadInvites() {
    if (!window.Charon.can("invitationCodes", "read")) { document.getElementById("invBody").innerHTML = '<tr><td colspan="6" class="muted">No access.</td></tr>'; return; }
    window.api.get("/endpoints/invitations").then(function (data) {
      var body = document.getElementById("invBody");
      if (!data.codes.length) { body.innerHTML = '<tr><td colspan="6" class="muted">No invitation codes.</td></tr>'; return; }
      body.innerHTML = data.codes.map(invRow).join("");
      if (canInvite) data.codes.forEach(function (c) {
        var b = document.querySelector('[data-revinv="' + c.id + '"]');
        if (b) b.addEventListener("click", function () { window.api.del("/endpoints/invitations/" + c.id).then(loadInvites).catch(err); });
      });
    });
  }

  function invRow(c) {
    var esc = window.Charon.escapeHtml;
    var status = c.revokedAt ? '<span class="badge badge-error">revoked</span>'
      : (c.expiresAt && new Date(c.expiresAt) < new Date()) ? '<span class="badge badge-warning">expired</span>'
      : '<span class="badge badge-info">active</span>';
    var revoke = canInvite && !c.revokedAt ? '<button class="btn btn-sm" data-revinv="' + c.id + '">Revoke</button>' : "";
    return "<tr>" +
      "<td>" + esc(c.label || "—") + "</td>" +
      "<td><code>" + esc(c.codePrefix) + "…</code></td>" +
      "<td>" + c.useCount + " / " + c.maxUses + "</td>" +
      "<td>" + (c.expiresAt ? new Date(c.expiresAt).toLocaleString() : "never") + "</td>" +
      "<td>" + status + "</td>" +
      "<td>" + revoke + "</td></tr>";
  }

  // ─── Invite modal ──────────────────────────────────────────────────────────
  function wireInviteModal() {
    document.getElementById("inviteBtn").addEventListener("click", function () {
      document.getElementById("inviteResult").hidden = true;
      document.getElementById("inviteError").hidden = true;
      document.getElementById("inviteCreate").disabled = false;
      document.getElementById("inviteModal").hidden = false;
    });
    document.getElementById("inviteClose").addEventListener("click", function () { document.getElementById("inviteModal").hidden = true; loadInvites(); });
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
