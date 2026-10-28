/**
 * public/js/server-settings.js — Server Settings page shell (tab visibility,
 * switching, ?tab= persistence, lazy loads). Ported from polaris; each tab's
 * body lives in its own server-settings-<tab>.js module.
 * Note: the "Web Server" tab keeps the internal key `certificates` (data-tab,
 * loadCertificates) from before it was renamed — only its label changed.
 */

/**
 * Which tabs this operator may see. Backend guards are the source of truth —
 * this is the UX hide. Polaris gated most tabs on isAdmin(); Charon's roles are
 * a dynamic matrix, so each tab rides the function key its routes check
 * (src/api/middleware/permissions.ts). A pure decider so the rule is testable.
 */
var SETTINGS_TAB_PERMS = {
  identification: "serverSettingsSystem",
  credentials: "credentials",
  customization: "serverSettingsSystem",
  ntp: "serverSettingsSystem",
  certificates: "serverSettingsSystem",
  auth: "serverSettingsSystem",
  maintenance: "serverSettingsData",
  retention: "serverSettingsData",
  "api-tokens": "apiTokens",
  ha: "serverSettingsSystem",
};
function _settingsTabVisible(key) {
  var perm = SETTINGS_TAB_PERMS[key];
  return !!perm && typeof permAtLeast === "function" && permAtLeast(perm, "read");
}

function _activateSettingsTab(target) {
  document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) {
    t.classList.toggle("active", t.getAttribute("data-tab") === target);
  });
  document.querySelectorAll(".page-tab-panel").forEach(function (p) {
    p.classList.toggle("active", p.id === "tab-" + target);
  });
  // Lazy-load tabs on first activation
  if (target === "ntp" && !_ntpLoaded) loadNtpSettings();
  if (target === "certificates" && !_certsLoaded) loadCertificates();
  if (target === "maintenance" && !_dbLoaded) loadDatabaseInfo();
  if (target === "identification" && !_tagsLoaded) loadIdentificationTab();
  if (target === "customization" && !_brandingLoaded) loadCustomizationTab();
  if (target === "credentials" && !_credsLoaded) loadCredentialsTab();
  if (target === "retention" && !_retentionLoaded) loadRetentionTab();
  if (target === "api-tokens" && !_apiTokensLoaded) loadApiTokensTab();
  if (target === "auth" && window.CharonAuthTab) window.CharonAuthTab.load();
  // High Availability lives in its own module (server-settings-ha.js):
  // the tab is a build procedure with its own state machine, and it
  // polls while visible because a node registering arrives from
  // another machine. It reloads on every activation rather than once,
  // so returning to it shows current cluster state.
  if (target === "ha" && window.PolarisHaTab) window.PolarisHaTab.load();
}

document.addEventListener("DOMContentLoaded", function () {
  // Permission globals come from /auth/me (settings-ui.js); nothing below can
  // decide visibility until they are in.
  window.__charonUserReady.then(function () {
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) {
      if (!_settingsTabVisible(t.getAttribute("data-tab"))) t.style.display = "none";
    });
    document.querySelectorAll(".page-tab-panel").forEach(function (p) {
      if (!_settingsTabVisible(p.id.replace(/^tab-/, ""))) p.style.display = "none";
    });

    // Tab switching
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-tab");
        _activateSettingsTab(target);
        // Persist the active tab in the URL so a page refresh restores it
        // (read back via the ?tab= handler below on load). replaceState keeps
        // it out of the back/forward history.
        try {
          var u = new URL(window.location.href);
          u.searchParams.set("tab", target);
          window.history.replaceState(null, "", u);
        } catch (e) { /* non-fatal: tab still switches */ }
      });
    });

    // Check for ?tab= query parameter to open a specific tab
    var urlParams = new URLSearchParams(window.location.search);
    var requestedTab = urlParams.get("tab");
    // Back-compat: ?tab=database now maps to the renamed Maintenance tab.
    if (requestedTab === "database") requestedTab = "maintenance";
    if (requestedTab) {
      var tabBtn = document.querySelector('#settings-tabs .page-tab[data-tab="' + requestedTab + '"]');
      // A hidden button is a tab this role may not see: fall through to the
      // default landing rather than activating an empty panel.
      if (tabBtn && tabBtn.style.display !== "none") {
        tabBtn.click();
        return;
      }
    }

    // Land on the first tab this role may see (Identification for an admin,
    // per the HTML order).
    var first = null;
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) {
      if (!first && t.style.display !== "none") first = t.getAttribute("data-tab");
    });
    if (first) _activateSettingsTab(first);
  });
});
