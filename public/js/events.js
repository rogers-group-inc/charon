/**
 * public/js/events.js — Audit log page.
 *
 * Uses the shared TableSF pattern (see TEMPLATES.md): per-column inline
 * filtering + sorting via TableSF, and resizable / show-hide "adjustable"
 * columns via setupColumnLayout. Column prefs (widths + hidden) persist in
 * localStorage so a user's layout survives reloads.
 */
(function () {
  "use strict";
  var LEVEL_BADGE = { info: "badge-monitor", warning: "badge-maintenance", error: "badge-conflict" };
  var PREFS_KEY = "charon-events-cols";
  var COL_COUNT = 6;

  var raw = [];      // last-fetched events
  var sf = null;     // TableSF instance
  var layout = null; // setupColumnLayout handle

  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      // TableSF drives sort + inline per-column filters; onChange re-renders
      // from the cached rows (no re-fetch needed).
      sf = new TableSF("eventsBody", render);

      // Adjustable columns: resizable widths + a show/hide chooser button.
      layout = setupColumnLayout(document.getElementById("events-table"), {
        chooserButton: document.getElementById("btn-columns"),
        onChange: savePrefs,
      });
      restorePrefs();

      document.getElementById("btn-refresh").addEventListener("click", load);
      load();
    });
  });

  function load() {
    window.api.get("/events?limit=500").then(function (data) {
      raw = data.events || [];
      render();
    }).catch(function (err) {
      document.getElementById("eventsBody").innerHTML =
        '<tr><td colspan="' + COL_COUNT + '" class="empty-state">' + window.Charon.escapeHtml(err.message) + "</td></tr>";
    });
  }

  // Re-render the tbody from the cached rows through TableSF (filter + sort).
  function render() {
    var rows = sf ? sf.apply(raw) : raw;
    var body = document.getElementById("eventsBody");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="' + COL_COUNT + '" class="empty-state">No matching events.</td></tr>';
      return;
    }
    var esc = window.Charon.escapeHtml;
    body.innerHTML = rows.map(function (e) {
      // Column order MUST match the <thead> so hide/resize line up.
      return "<tr>" +
        "<td>" + new Date(e.timestamp).toLocaleString() + "</td>" +
        '<td><span class="badge ' + (LEVEL_BADGE[e.level] || "") + '">' + e.level + "</span></td>" +
        "<td>" + esc(e.action) + "</td>" +
        "<td>" + esc(e.resourceName || e.resourceType || "") + "</td>" +
        "<td>" + esc(e.actor || "") + "</td>" +
        "<td>" + esc(e.message) + "</td>" +
        "</tr>";
    }).join("");
    if (layout && layout.refresh) layout.refresh();
  }

  function savePrefs() {
    if (!layout) return;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(layout.getPrefs())); } catch (_) {}
  }
  function restorePrefs() {
    if (!layout) return;
    try {
      var p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (p) layout.setPrefs(p);
    } catch (_) {}
  }
})();
