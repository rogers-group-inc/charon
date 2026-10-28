/**
 * public/js/login.js — Local login + TOTP step.
 *
 * POSTs credentials to /auth/login. When the server replies mfaRequired, the
 * TOTP field is revealed and the code is verified via /auth/login/totp. On
 * success, redirects to the dashboard.
 */
(function () {
  "use strict";

  var form = document.getElementById("loginForm");
  var totpGroup = document.getElementById("totpGroup");
  var totpInput = document.getElementById("totp");
  var errEl = document.getElementById("loginError");
  var btn = document.getElementById("loginBtn");
  var mfaPending = false;

  // Branding (Server Settings → Customization): name, subtitle and — when
  // "show on login page" is on — the custom logo. Public endpoint; a failure
  // just leaves the built-in Charon text.
  fetch("/api/v1/branding", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) {
      if (!b) return;
      if (b.appName) {
        document.getElementById("loginAppName").textContent = b.appName;
        document.title = b.appName + " — Sign in";
      }
      document.getElementById("loginSubtitle").textContent = b.subtitle || "";
      if (b.logoUrl) {
        var img = document.getElementById("loginLogo");
        img.src = b.logoUrl + (b.logoVersion ? "?v=" + encodeURIComponent(b.logoVersion) : "");
        img.alt = b.appName || "";
        img.hidden = false;
      }
    })
    .catch(function () {});

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errEl.hidden = true;
    btn.disabled = true;

    var done = function () { btn.disabled = false; };

    if (mfaPending) {
      window.api.post("/auth/login/totp", { code: totpInput.value }, { noRedirect: true })
        .then(function () { location.href = "/index.html"; })
        .catch(function (err) { showError(err.message); done(); });
      return;
    }

    window.api.post("/auth/login", {
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
    }, { noRedirect: true })
      .then(function (res) {
        if (res && res.mfaRequired) {
          mfaPending = true;
          totpGroup.hidden = false;
          totpInput.required = true;
          totpInput.focus();
          done();
          return;
        }
        location.href = "/index.html";
      })
      .catch(function (err) { showError(err.message); done(); });
  });
})();
