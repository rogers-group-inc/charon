/**
 * public/js/setup.js — First-run wizard (runs on the setup server, no session).
 */
(function () {
  "use strict";
  var SETUP_BASE = "/api/setup";

  function post(path, body) {
    return fetch(SETUP_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  document.getElementById("testDbBtn").addEventListener("click", function () {
    var out = document.getElementById("testDbResult");
    out.textContent = "Testing…";
    post("/test-db", { databaseUrl: document.getElementById("databaseUrl").value })
      .then(function () { out.textContent = "✓ Connected"; })
      .catch(function (err) { out.textContent = "✗ " + err.message; });
  });

  document.getElementById("setupForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = document.getElementById("setupError");
    var ok = document.getElementById("setupOk");
    var btn = document.getElementById("finalizeBtn");
    err.hidden = true; ok.hidden = true; btn.disabled = true;

    var payload = {
      databaseUrl: document.getElementById("databaseUrl").value,
      adminUsername: document.getElementById("adminUsername").value,
      adminPassword: document.getElementById("adminPassword").value,
    };
    var pub = document.getElementById("publicUrl").value;
    if (pub) payload.publicUrl = pub;

    post("/finalize", payload)
      .then(function (data) {
        ok.textContent = data.message + " You can close this page.";
        ok.hidden = false;
      })
      .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
  });
})();
