/**
 * public/js/dashboard.js — Dashboard page bootstrap.
 *
 * Loads the current user (renders the sidebar), then reads /health for the HA
 * leader/role badge. The endpoint/session/sync/posture tiles populate once
 * those subsystems land; for now they show a placeholder.
 */
(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", function () {
    window.Charon.init().then(function () {
      fetch("/health").then(function (r) { return r.json(); }).then(function (h) {
        document.getElementById("mLeader").textContent = h.role || "—";
      }).catch(function () {});
    });
  });
})();
