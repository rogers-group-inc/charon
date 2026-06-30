/**
 * public/js/events.js — Audit log page.
 */
(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(loadEvents);
  });

  function loadEvents() {
    window.api.get("/events?limit=100").then(function (data) {
      var body = document.getElementById("eventsBody");
      if (!data.events.length) {
        body.innerHTML = '<tr><td colspan="5" class="muted">No events yet.</td></tr>';
        return;
      }
      body.innerHTML = data.events.map(function (e) {
        return "<tr>" +
          "<td>" + new Date(e.timestamp).toLocaleString() + "</td>" +
          '<td><span class="badge badge-' + e.level + '">' + e.level + "</span></td>" +
          "<td>" + window.Charon.escapeHtml(e.action) + "</td>" +
          "<td>" + window.Charon.escapeHtml(e.actor || "") + "</td>" +
          "<td>" + window.Charon.escapeHtml(e.message) + "</td>" +
          "</tr>";
      }).join("");
    }).catch(function (err) {
      document.getElementById("eventsBody").innerHTML =
        '<tr><td colspan="5" class="form-error">' + window.Charon.escapeHtml(err.message) + "</td></tr>";
    });
  }
})();
