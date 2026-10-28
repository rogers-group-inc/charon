/**
 * public/js/server-settings-customization.js — Server Settings: Customization tab (branding, logo, reboot settings).
 * Ported from polaris public/js/server-settings.js (split per tab; every
 * declaration stays a page global, exactly as in the single polaris file).
 */

// ─── Customization Tab ─────────────────────────────────────────────────────

var _brandingLoaded = false;
// Charon: no shipped logo art — the default brand is the name + subtitle as
// text, so the default logoUrl is "" (see services/brandingService.ts).
var DEFAULT_LOGO_URLS = [""];
var _brandingData = { appName: "Charon", subtitle: "Zero Trust Network Access", logoUrl: "" };

var _rebootSettingsData = null;

async function loadCustomizationTab() {
  var container = document.getElementById("tab-customization");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    // The Reboots card's setting rides along; a failed read renders the card
    // as an error rather than failing the whole tab.
    var both = await Promise.all([
      api.serverSettings.getBranding(),
      api.serverSettings.rebootGet().then(function (r) { return r.reboot; }, function () { return null; }),
    ]);
    _brandingData = both[0];
    _rebootSettingsData = both[1];
    _brandingLoaded = true;
    renderCustomizationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderCustomizationTab() {
  var container = document.getElementById("tab-customization");
  // `customLogo` is computed server-side (brandingService.hasCustomLogo); the
  // path comparison is the fallback for a pre-upgrade payload.
  var isCustomLogo = _brandingData.customLogo !== undefined
    ? _brandingData.customLogo
    : Boolean(_brandingData.logoUrl && DEFAULT_LOGO_URLS.indexOf(_brandingData.logoUrl) === -1);
  // Placement defaults ON the same way the server does, so an install that has
  // never saved this card renders its real behavior.
  // Charon: no logo accent — polaris composites its star onto the logo
  // server-side (brandLogoService); Charon has no symbol art to overlay.
  var logoOnLogin   = _brandingData.logoOnLogin !== false;
  var logoOnSidebar = _brandingData.logoOnSidebar !== false;
  // Cache-busted by the server-derived logoVersion since the upload route
  // reuses one filename. Charon: no default art — the preview shows the name.
  var previewSrc = isCustomLogo
    ? _brandingData.logoUrl + (_brandingData.logoVersion ? "?v=" + encodeURIComponent(_brandingData.logoVersion) : "")
    : "";

  container.innerHTML =
    '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
      '<h4>Application Name</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        // Charon: no wordmark art, so the name is always printed in the
        // sidebar (beneath your logo when one is set) — polaris prints it only
        // beside a custom logo.
        'Change the name shown in the sidebar and browser tabs. ' +
        'With a custom logo it is printed beneath the logo; ' +
        'leave it blank if your own logo carries your wordmark.' +
      '</p>' +
      '<div class="form-group"><label>Application Name</label>' +
        '<input type="text" id="f-brand-appname" maxlength="100" value="' + escapeHtml(_brandingData.appName || "") + '" placeholder="e.g. Charon">' +
      '</div>' +
      '<div class="form-group"><label>Subtitle</label>' +
        '<input type="text" id="f-brand-subtitle" maxlength="100" value="' + escapeHtml(_brandingData.subtitle || "") + '" placeholder="e.g. Zero Trust Network Access">' +
        '<p class="hint">Shown beneath the application name on the sidebar and login page.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-brand-save">Save</button>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Logo</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Upload a custom logo to show above the application name. Recommended size: 280×280px or larger. Supported formats: PNG, JPEG, WebP. ' +
        'Wherever your logo is switched off below, Charon shows the application name on its own.' +
      '</p>' +
      '<div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap">' +
        '<div style="flex-shrink:0">' +
          '<div class="logo-preview-box">' +
            // Charon: no default logo art — preview the text brand instead.
            (previewSrc
              ? '<img id="logo-preview" src="' + escapeHtml(previewSrc) + '" alt="Current logo">'
              : '<span id="logo-preview" style="font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--color-text-primary);text-align:center;padding:0.5rem;word-break:break-word">' +
                  escapeHtml(_brandingData.appName || "Charon") + '</span>') +
          '</div>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.5rem;text-align:center">' +
            (isCustomLogo ? 'Custom logo' : 'No logo (name only)') +
          '</p>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="upload-area" id="logo-upload-area">' +
            '<input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp">' +
            '<strong style="color:var(--color-text-primary)">Upload New Logo</strong>' +
            '<p>Click to select an image file</p>' +
          '</div>' +
          (isCustomLogo
            ? '<button class="btn btn-secondary" id="btn-logo-reset" style="margin-top:0.75rem">Reset to Default</button>'
            : '') +
        '</div>' +
      '</div>' +
      // Placement. Shown always so the options are discoverable, but
      // inert without a custom logo — they only choose where YOUR logo goes.
      '<div style="margin-top:1.25rem;border-top:1px solid var(--color-border);padding-top:1rem' +
        (isCustomLogo ? '' : ';opacity:0.55') + '">' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-login"' + (logoOnLogin ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo on the login page</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: the Charon name is shown there instead.</span>' +
          '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-sidebar"' + (logoOnSidebar ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo in the top-left corner after login</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: only the application name is shown in the sidebar.</span>' +
          '</span>' +
        '</label>' +
        // Charon: polaris's "Accent my logo with the Polaris symbol" option is
        // omitted (no symbol art / server-side compositing in Charon).
        '<button class="btn btn-primary" id="btn-logo-placement-save" style="margin-top:0.9rem"' + (isCustomLogo ? '' : ' disabled') + '>Save</button>' +
      '</div>' +
    '</div>' +
    // Charon: polaris's Display Units (hardware-sensor temperature) card is
    // omitted — Charon collects no sensor data.
    _rebootSettingsCardHtml(_rebootSettingsData) +
    '</div>';

  // Wire save buttons — every card PUTs the whole branding payload, so any one
  // of them persists whatever the operator changed on this tab.
  document.getElementById("btn-brand-save").addEventListener("click", function () { saveBranding(false); });
  var placementBtn = document.getElementById("btn-logo-placement-save");
  // Re-render after this one: the preview swaps to (or away from) the
  // server-composited accent version.
  if (placementBtn) placementBtn.addEventListener("click", function () { saveBranding(true); });
  var rebootBtn = document.getElementById("btn-reboot-settings-save");
  if (rebootBtn) rebootBtn.addEventListener("click", saveRebootSettings);

  // Wire logo upload
  wireUploadArea("logo-upload-area", "logo-file-input", uploadLogo);

  // Wire reset button
  var resetBtn = document.getElementById("btn-logo-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetLogo);
  }
}

/**
 * The Reboots card (business rule 115(d)): whether every reboot — now or
 * booked, from the desktop, the phone or the API — must say why. Pure.
 */
function _rebootSettingsCardHtml(s) {
  if (!s) {
    return '<div class="settings-card"><h4>Reboots</h4><p class="empty-state">Could not load the reboot settings.</p></div>';
  }
  return '<div class="settings-card">' +
    '<h4>Reboots</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'The Reboot dialog always offers a <strong>Reason</strong> field. It is recorded on the device’s Events, ' +
      'shown in its reboot history, and printed in the results email of a scheduled reboot.' +
    '</p>' +
    '<label style="display:flex;align-items:flex-start;gap:0.5rem">' +
      '<input type="checkbox" id="f-reboot-require-note"' + (s.requireNote ? ' checked' : '') + ' style="margin-top:0.2rem">' +
      '<span><strong>Require a reason for every reboot</strong>' +
        '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">' +
          'A reboot or a scheduled reboot without one is refused — in the dialog, on the phone and over the API. ' +
          'Reboots an automation books give the automation’s name as their reason. Bookings made before this was turned on still run.' +
        '</span>' +
      '</span>' +
    '</label>' +
    '<button class="btn btn-primary" id="btn-reboot-settings-save" style="margin-top:0.9rem">Save</button>' +
  '</div>';
}

async function saveRebootSettings() {
  var btn = document.getElementById("btn-reboot-settings-save");
  var box = document.getElementById("f-reboot-require-note");
  if (!btn || !box) return;
  btn.disabled = true;
  try {
    var res = await api.serverSettings.rebootPut({ requireNote: box.checked });
    _rebootSettingsData = res.reboot;
    showToast(res.reboot.requireNote ? "A reason is now required for every reboot" : "The reboot reason is now optional");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function saveBranding(rerender) {
  var btns = ["btn-brand-save", "btn-tempunit-save", "btn-logo-placement-save"]
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  // Remember which were already disabled (the placement block is, without a
  // custom logo) so re-enabling can't hand out a control the card had greyed.
  var wasDisabled = btns.map(function (b) { return b.disabled; });
  btns.forEach(function (b) { b.disabled = true; });
  try {
    var unitEl = document.getElementById("f-brand-tempunit");
    var loginEl = document.getElementById("f-logo-on-login");
    var sidebarEl = document.getElementById("f-logo-on-sidebar");
    var accentEl = document.getElementById("f-logo-accent");
    var data = {
      appName: document.getElementById("f-brand-appname").value.trim(),
      subtitle: document.getElementById("f-brand-subtitle").value.trim(),
      temperatureUnit: unitEl ? unitEl.value : undefined,
    };
    // Omitted rather than sent as undefined-ish: the PUT falls back to the
    // stored value per field, so a card that didn't render these can't clear them.
    if (loginEl)   data.logoOnLogin   = loginEl.checked;
    if (sidebarEl) data.logoOnSidebar = sidebarEl.checked;
    if (accentEl)  data.logoAccent    = accentEl.checked;
    _brandingData = await api.serverSettings.updateBranding(data);
    // Charon: applyBranding() also repaints the live sidebar (app.js).
    applyBranding(_brandingData);
    showToast("Branding saved");
    if (rerender) renderCustomizationTab();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btns.forEach(function (b, i) { b.disabled = wasDisabled[i]; });
  }
}

async function uploadLogo(files) {
  if (!files || files.length === 0) return;
  var file = files[0];
  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file", "error");
    return;
  }
  try {
    _brandingData = await api.serverSettings.uploadLogo(file);
    applyBranding(_brandingData);
    // Charon: applyBranding() repaints the sidebar; the payload's logoVersion
    // changes with every upload, so the <img> URL changes and re-fetches.
    renderCustomizationTab();
    showToast("Logo uploaded");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetLogo() {
  var ok = await showConfirm("Reset to the default logo?");
  if (!ok) return;
  try {
    _brandingData = await api.serverSettings.deleteLogo();
    applyBranding(_brandingData);
    // Charon: applyBranding() repaints the sidebar; the payload's logoVersion
    // changes with every upload, so the <img> URL changes and re-fetches.
    renderCustomizationTab();
    showToast("Logo reset to default");
  } catch (err) {
    showToast(err.message, "error");
  }
}

