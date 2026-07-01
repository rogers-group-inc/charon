/**
 * public/js/events.js — Audit log page.
 */
(function () {
  "use strict";
  // Map Charon event levels to polaris badge variants (styles.css).
  var LEVEL_BADGE = { info: "badge-monitor", warning: "badge-maintenance", error: "badge-conflict" };

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(loadEvents);
    var refresh = document.getElementById("btn-refresh");
    if (refresh) refresh.addEventListener("click", loadEvents);
  });

  function loadEvents() {
    window.api.get("/events?limit=100").then(function (data) {
      var body = document.getElementById("eventsBody");
      if (!data.events.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty-state">No events yet.</td></tr>';
        return;
      }
      body.innerHTML = data.events.map(function (e) {
        return "<tr>" +
          "<td>" + new Date(e.timestamp).toLocaleString() + "</td>" +
          '<td><span class="badge ' + (LEVEL_BADGE[e.level] || "") + '">' + e.level + "</span></td>" +
          "<td>" + window.Charon.escapeHtml(e.action) + "</td>" +
          "<td>" + window.Charon.escapeHtml(e.actor || "") + "</td>" +
          "<td>" + window.Charon.escapeHtml(e.message) + "</td>" +
          "</tr>";
      }).join("");
    }).catch(function (err) {
      document.getElementById("eventsBody").innerHTML =
        '<tr><td colspan="5" class="empty-state">' + window.Charon.escapeHtml(err.message) + "</td></tr>";
    });
  }
})();
