/**
 * public/js/server-settings-auth.js — Server Settings: Authentication tab.
 *
 * Charon's own tab (polaris has no equivalent): the active login mode, which
 * drives both operator login and the endpoint agent's server-dictated login
 * GUI. Built from the same settings-card markup as the ported polaris tabs.
 */
(function () {
  "use strict";

  var _loaded = false;

  function render(container, mode) {
    var canEdit = permAtLeast("serverSettingsSystem", "fullwrite");
    container.innerHTML =
      '<div class="settings-card">' +
        '<h3>Active login mode</h3>' +
        '<p class="settings-description">Drives both operator login and the endpoint agent\'s login GUI.</p>' +
        '<div class="form-group">' +
          '<label for="auth-mode">Login mode</label>' +
          '<select id="auth-mode"' + (canEdit ? "" : " disabled") + '>' +
            '<option value="local">Local (password + TOTP)</option>' +
            '<option value="saml">SAML</option>' +
            '<option value="oidc">OIDC</option>' +
          '</select>' +
        '</div>' +
        (canEdit ? '<div class="settings-actions"><button class="btn btn-primary" id="auth-mode-save">Save</button></div>' : "") +
      '</div>';
    document.getElementById("auth-mode").value = mode;
    var btn = document.getElementById("auth-mode-save");
    if (btn) btn.addEventListener("click", save);
  }

  async function save() {
    var mode = document.getElementById("auth-mode").value;
    if (!(await showConfirm("Switch the active login mode to " + mode.toUpperCase() + "? Operators and endpoint agents use it on their next sign-in."))) return;
    try {
      await api.serverSettings.authModePut({ mode: mode });
      showToast("Login mode saved");
    } catch (err) {
      showToast(err.message || "Save failed", "error");
    }
  }

  async function load() {
    if (_loaded) return;
    _loaded = true;
    var container = document.getElementById("tab-auth");
    container.innerHTML = '<p class="settings-description">Loading…</p>';
    try {
      var d = await api.serverSettings.authModeGet();
      render(container, d.mode);
    } catch (err) {
      _loaded = false;
      container.innerHTML = '<p class="settings-description">' + escapeHtml(err.message || "Failed to load") + "</p>";
    }
  }

  window.CharonAuthTab = { load: load };
})();
