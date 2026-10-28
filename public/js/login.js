/**
 * public/js/login.js — the sign-in page (polaris login flow, Charon wiring).
 *
 * Entry paths: local / LDAP password (POST /auth/login), passkey
 * (POST /auth/passkeys/login), and the SSO buttons (SAML / OIDC / App Proxy),
 * each shown only when its public config probe says it can work.
 *
 * Every completed step answers one of three outcomes — signed in,
 * { mfaRequired, methods }, or { passwordChangeRequired, policy } — and
 * handleOutcome() routes them, so "second factor, then forced change" works
 * without the steps knowing about each other. The half-finished login lives
 * in the server session (no token round-trips here).
 *
 * After sign-in the page lands on the remembered target (the charon_next
 * cookie the server set when it bounced a deep link here), same-origin paths
 * only.
 */
(function () {
  "use strict";

  var errEl = document.getElementById("loginError");
  var noticeEl = document.getElementById("loginNotice");
  var post = function (path, body) { return window.api.post(path, body, { noRedirect: true }); };

  function showError(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function clearError() { errEl.hidden = true; }
  function show(id, on) { document.getElementById(id).hidden = !on; }

  // ─── Query-string messages (textContent only: ?error= comes back from SSO
  // redirects and can be attacker-influenced) ─────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  if (params.get("error")) showError(params.get("error").replace(/_/g, " "));
  if (params.get("reason") === "inactivity") {
    noticeEl.textContent = "You were signed out after a period of inactivity.";
    noticeEl.hidden = false;
  }

  // ─── Branding (Server Settings → Customization) ────────────────────────────
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

  // ─── Where to land ──────────────────────────────────────────────────────────
  // Only an unambiguous same-origin path survives: no control characters (the
  // URL parser strips tab / CR / LF before resolving), resolved by the
  // browser's own parser, same origin, exactly one leading "/", never the
  // login page itself (that reads as a failed login).
  function safeLoginTarget(raw) {
    if (typeof raw !== "string" || !raw || /[\u0000-\u001f\u007f]/.test(raw)) return "/";
    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/" || raw.charAt(1) === "\\") return "/";
    var url;
    try { url = new URL(raw, window.location.origin); } catch (_) { return "/"; }
    if (url.origin !== window.location.origin) return "/";
    if (url.pathname.charAt(0) !== "/" || url.pathname.charAt(1) === "/") return "/";
    if (url.pathname === "/login.html") return "/";
    return url.pathname + url.search + url.hash;
  }
  function takeLoginTarget() {
    var raw = null;
    (document.cookie || "").split(";").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== "charon_next") return;
      try { raw = decodeURIComponent(part.slice(eq + 1).trim()); } catch (_) { raw = null; }
    });
    document.cookie = "charon_next=; Max-Age=0; Path=/";
    return safeLoginTarget(raw);
  }
  window.CharonLoginTarget = { safe: safeLoginTarget }; // tests

  // ─── Outcome routing ────────────────────────────────────────────────────────
  function handleOutcome(res) {
    if (res && res.mfaRequired) return showMfaStep(res.methods || { totp: true, passkey: false });
    if (res && res.passwordChangeRequired) return showPasswordChangeStep(res.policy);
    window.location.href = takeLoginTarget();
  }

  // ─── Step 1: password ───────────────────────────────────────────────────────
  var loginBtn = document.getElementById("loginBtn");
  document.getElementById("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    loginBtn.disabled = true;
    post("/auth/login", {
      username: document.getElementById("username").value.trim(),
      password: document.getElementById("password").value,
    })
      .then(handleOutcome)
      .catch(function (err) { showError(err.message); })
      .then(function () { loginBtn.disabled = false; });
  });

  // ─── SSO buttons — each only when its provider says it can work ────────────
  function probe(path) {
    return fetch("/api/v1" + path, { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  }
  function revealSso(btnId, href, label) {
    var b = document.getElementById(btnId);
    if (label) b.textContent = label;
    b.hidden = false;
    b.addEventListener("click", function () { window.location.href = href; });
    show("ssoSection", true);
  }
  probe("/auth/saml/config").then(function (c) {
    if (!c.enabled) return;
    var labels = { microsoft: "Sign in with Microsoft", google: "Sign in with Google", okta: "Sign in with Okta" };
    revealSso("btnSaml", "/api/v1/auth/saml/login", labels[c.brand] || "Sign in with SSO");
  });
  probe("/auth/oidc/config").then(function (c) { if (c.enabled) revealSso("btnOidc", "/api/v1/auth/oidc/login"); });
  // `available` = THIS request came through a trusted App Proxy connector with
  // identity headers; internal users never see the button.
  probe("/auth/entra-proxy/config").then(function (c) { if (c.enabled && c.available) revealSso("btnEntraProxy", "/api/v1/auth/entra-proxy/login"); });

  // ─── Passkey sign-in ────────────────────────────────────────────────────────
  // Shown only when the install allows passkey sign-in, someone has registered
  // one, and this page can run a ceremony for the RP the server derived.
  var webauthn = window.PolarisWebAuthn;
  if (webauthn && webauthn.supported()) {
    probe("/auth/passkeys/config").then(function (c) {
      if (c.loginEnabled && c.anyRegistered && !webauthn.unavailableHere(c.rpId)) show("passkeySection", true);
    });
  }

  async function runPasskey(optionsPath, finishPath) {
    var start = await post(optionsPath, {});
    var assertion;
    try {
      assertion = await webauthn.get(start.options);
    } catch (err) {
      throw new Error(webauthn.describeError(err));
    }
    return post(finishPath, { token: start.token, response: assertion });
  }

  document.getElementById("btnPasskey").addEventListener("click", function () {
    var btn = this;
    clearError();
    btn.disabled = true;
    runPasskey("/auth/passkeys/login/options", "/auth/passkeys/login")
      .then(handleOutcome)
      .catch(function (err) { showError(err.message); })
      .then(function () { btn.disabled = false; });
  });

  // ─── Step 2: second factor ──────────────────────────────────────────────────
  function showMfaStep(methods) {
    show("entrySection", false);
    show("mfaSection", true);
    var hasTotp = !!methods.totp;
    var canPasskey = !!methods.passkey && webauthn && webauthn.supported();
    // Both: start on the code form (no dialog opens uninvited) and allow a switch.
    show("mfaForm", hasTotp);
    show("mfaPasskeyBlock", !hasTotp);
    show("btnMfaSwitch", hasTotp && canPasskey);
    if (!hasTotp && !canPasskey) {
      document.getElementById("btnMfaPasskey").disabled = true;
      document.getElementById("mfaPasskeyHint").textContent =
        "This account uses a passkey as its second factor, and this browser cannot use passkeys here (they need an HTTPS connection).";
    }
    if (hasTotp) setTimeout(function () { document.getElementById("mfaCode").focus(); }, 30);
  }

  document.getElementById("btnMfaSwitch").addEventListener("click", function (e) {
    e.preventDefault();
    var usingCode = !document.getElementById("mfaForm").hidden;
    show("mfaForm", !usingCode);
    show("mfaPasskeyBlock", usingCode);
    this.textContent = usingCode ? "Use a verification code instead" : "Use a passkey instead";
  });

  document.getElementById("btnUseBackup").addEventListener("click", function (e) {
    e.preventDefault();
    var input = document.getElementById("mfaCode");
    var backup = input.dataset.mode !== "backup";
    input.dataset.mode = backup ? "backup" : "totp";
    input.maxLength = backup ? 9 : 6;
    input.placeholder = backup ? "XXXX-XXXX" : "123456";
    input.inputMode = backup ? "text" : "numeric";
    input.value = "";
    document.getElementById("mfaCodeLabel").textContent = backup ? "Backup code" : "Verification code";
    document.getElementById("mfaHint").textContent = backup
      ? "Enter one of the backup codes you saved when enabling two-factor auth."
      : "Enter the 6-digit code from your authenticator app.";
    this.textContent = backup ? "Use the authenticator app instead" : "Use a backup code";
    input.focus();
  });

  document.getElementById("mfaForm").addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    var input = document.getElementById("mfaCode");
    var code = input.value.trim();
    if (!code) return;
    post("/auth/login/totp", { code: code, isBackupCode: input.dataset.mode === "backup" })
      .then(handleOutcome)
      .catch(function (err) {
        showError(err.message);
        // The server dropped the half-finished login (expired or locked): start over.
        if (/expired|locked/i.test(err.message)) setTimeout(function () { window.location.reload(); }, 2500);
        else input.select();
      });
  });

  document.getElementById("btnMfaPasskey").addEventListener("click", function () {
    var btn = this;
    clearError();
    btn.disabled = true;
    runPasskey("/auth/login/passkey/options", "/auth/login/passkey")
      .then(handleOutcome)
      .catch(function (err) { showError(err.message); })
      .then(function () { btn.disabled = false; });
  });

  // ─── Step 3: forced password change ─────────────────────────────────────────
  // The checklist is drawn from the policy the server just sent, so what this
  // step demands is exactly what the server will accept.
  var RULE_TESTS = {
    lower: function (p) { return /[a-z]/.test(p); },
    upper: function (p) { return /[A-Z]/.test(p); },
    number: function (p) { return /[0-9]/.test(p); },
    special: function (p) { return /[^a-zA-Z0-9]/.test(p); },
  };
  var activeRules = [];

  function showPasswordChangeStep(policy) {
    policy = policy || { minLength: 8 };
    show("entrySection", false);
    show("mfaSection", false);
    show("pwChangeSection", true);
    activeRules = [{ key: "length", label: "At least " + policy.minLength + " characters", test: function (p) { return p.length >= policy.minLength; } }];
    if (policy.requireLowercase) activeRules.push({ key: "lower", label: "Lowercase letter", test: RULE_TESTS.lower });
    if (policy.requireUppercase) activeRules.push({ key: "upper", label: "Uppercase letter", test: RULE_TESTS.upper });
    if (policy.requireNumber) activeRules.push({ key: "number", label: "Number", test: RULE_TESTS.number });
    if (policy.requireSpecial) activeRules.push({ key: "special", label: "Special character", test: RULE_TESTS.special });
    renderRules("");
    setTimeout(function () { document.getElementById("pwNew").focus(); }, 30);
  }

  function renderRules(pw) {
    var ul = document.getElementById("pwRules");
    ul.innerHTML = "";
    activeRules.forEach(function (r) {
      var li = document.createElement("li");
      var ok = r.test(pw);
      li.className = ok ? "ok" : "";
      li.textContent = (ok ? "✓ " : "○ ") + r.label;
      ul.appendChild(li);
    });
  }
  document.getElementById("pwNew").addEventListener("input", function () { renderRules(this.value); });

  document.getElementById("pwChangeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    var next = document.getElementById("pwNew").value;
    if (!activeRules.every(function (r) { return r.test(next); })) return showError("The new password does not meet the password policy.");
    if (next !== document.getElementById("pwConfirm").value) return showError("The two passwords do not match.");
    post("/auth/login/password-change", { newPassword: next })
      .then(handleOutcome)
      .catch(function (err) { showError(err.message); });
  });
})();
