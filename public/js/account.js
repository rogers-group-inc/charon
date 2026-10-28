/**
 * public/js/account.js — My Account: the signed-in operator's own password,
 * two-factor auth and passkeys. Reached from the user badge on every page; no
 * permission gate (the routes behind it act only on the caller's own account).
 *
 * The modals are the shared polaris self-service modules (password-self.js,
 * totp-self.js, passkeys-self.js); this page only lays out their entry points
 * and their current state. SSO / LDAP accounts get the explanation instead of
 * the controls — their identity provider owns the password and MFA.
 */
(function () {
  "use strict";

  var PROVIDER_LABEL = {
    local: "Local account",
    ldap: "LDAP / Active Directory",
    saml: "SAML single sign-on",
    oidc: "OpenID Connect single sign-on",
    "entra-proxy": "Entra Application Proxy",
    passkey: "Local account (signed in with a passkey)",
  };

  function card(title, bodyHtml) {
    return '<div class="settings-card"><h4>' + escapeHtml(title) + '</h4>' + bodyHtml + '</div>';
  }

  function hint(text) {
    return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' + text + '</p>';
  }

  async function render() {
    var user = await window.__charonUserReady;
    if (!user) return;
    var local = !user.authProvider || user.authProvider === "local" || user.authProvider === "passkey";
    var totp = null;
    var passkeys = null;
    if (local) {
      try { totp = await api.totp.status(); } catch (_) { /* card says unknown */ }
      try { passkeys = await api.auth.passkeys(); } catch (_) { /* card says unknown */ }
    }
    var html = card("Identity",
      '<p style="margin-bottom:0.35rem"><strong>' + escapeHtml(user.displayName || user.username) + '</strong>' +
        (user.displayName ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(user.username) + ')</span>' : '') + '</p>' +
      '<p style="font-size:0.85rem;color:var(--color-text-secondary)">Role: ' + escapeHtml(user.role || "—") +
        ' · Signed in via ' + escapeHtml(PROVIDER_LABEL[user.authProvider] || user.authProvider || "local") + '</p>');

    if (!local) {
      html += card("Password and two-factor auth",
        hint("Your password and multi-factor sign-in are managed by your identity provider. Change them there."));
    } else {
      html += card("Password",
        hint("Change your own password. Your other signed-in sessions end when you do.") +
        '<button class="btn btn-secondary" id="acct-password">Change password</button>');
      var totpState = !totp ? "Status unavailable."
        : totp.enabled ? "Enabled — " + totp.backupCodesRemaining + " backup code" + (totp.backupCodesRemaining === 1 ? "" : "s") + " left."
          : "Not set up.";
      html += card("Two-factor authentication",
        hint("An authenticator-app code after your password. " + escapeHtml(totpState)) +
        '<button class="btn btn-secondary" id="acct-totp">' + (totp && totp.enabled ? "Manage" : "Set up") + '</button>');
      var pkCount = passkeys && passkeys.passkeys ? passkeys.passkeys.length : null;
      var pkAvail = passkeys && passkeys.availability;
      var pkNote = pkAvail && pkAvail.mode === "off" ? "Passkeys are turned off on this install."
        : pkAvail && pkAvail.unavailableReason ? escapeHtml(pkAvail.unavailableReason)
          : pkCount === null ? "Status unavailable."
            : pkCount + " registered.";
      html += card("Passkeys",
        hint("Sign in with your device's fingerprint, face or PIN, or a security key. " + pkNote) +
        '<button class="btn btn-secondary" id="acct-passkeys">Manage</button>');
    }
    document.getElementById("account-cards").innerHTML = html;

    var pw = document.getElementById("acct-password");
    if (pw) pw.addEventListener("click", function () { PolarisPasswordSelf.open({ username: user.username }); });
    var t = document.getElementById("acct-totp");
    if (t) t.addEventListener("click", function () { PolarisTotpSelf.open({ username: user.username, onChange: render }); });
    var pk = document.getElementById("acct-passkeys");
    if (pk) pk.addEventListener("click", function () { PolarisPasskeys.open({ onChange: render }); });
  }

  document.addEventListener("DOMContentLoaded", render);
})();
