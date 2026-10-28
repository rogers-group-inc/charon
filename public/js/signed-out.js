/**
 * public/js/signed-out.js — the post-logout landing's one dynamic line:
 * an inactivity sign-out says why.
 */
(function () {
  "use strict";
  if (new URLSearchParams(window.location.search).get("reason") !== "inactivity") return;
  document.getElementById("signedOutTitle").textContent = "Signed out after inactivity";
  document.getElementById("signedOutText").textContent =
    "Your session ended because it was idle for longer than this server allows. Sign in again to continue.";
})();
