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

  // Branding (Server Settings → Customization): name, subtitle and the mark —
  // brand-logo.js picks the custom logo (when "show on login page" is on), else
  // the shipped theme-paired art, else none and the name shows as text. Public
  // endpoint; a failure just leaves the built-in Charon text.
  var brandLogo = window.CharonBrandLogo;
  var logoImg = document.getElementById("loginLogo");
  var appNameEl = document.getElementById("loginAppName");
  var loginBranding = {};
  function paintBrand(b) {
    if (!brandLogo) return;
    var r = brandLogo.applyTo(logoImg, b, "login");
    appNameEl.hidden = !r.showName;
    if (r.custom) brandLogo.setFavicon(r.src);
  }
  paintBrand(loginBranding);
  if (brandLogo) brandLogo.onThemeChange(function () { paintBrand(loginBranding); });
  fetch("/api/v1/branding", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) {
      if (!b) return;
      loginBranding = b;
      if (b.appName) {
        appNameEl.textContent = b.appName;
        document.title = b.appName + " — Sign in";
      }
      document.getElementById("loginSubtitle").textContent = b.subtitle || "";
      paintBrand(b);
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
