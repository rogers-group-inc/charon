/**
 * public/js/server-settings-webserver.js — Server Settings: Web Server tab (internal key "certificates").
 * Ported from polaris public/js/server-settings.js (split per tab; every
 * declaration stays a page global, exactly as in the single polaris file).
 */

// ─── Web Server Tab (internal key "certificates") ────────────────────────────

var _certsLoaded = false;
var _certData = { trustedCAs: [], serverCerts: [] };
var _httpsSettings = { fingerprint: null, cn: null, dnsSans: [], ipSans: [], expiresAt: null, certPath: null };
var _proxyData = null;
var _ipv6Settings = null; // { mode, hostAddresses, enabled } | null while loading/failed
var _loginAccess = null;  // { settings, callerIp } | null while loading/failed

// Render the Web Server tab (data-tab="certificates"). nginx terminates TLS — five cards
// in a .settings-cards-flow deck (up to three columns, reflowing to two then
// one as the window narrows; the min column width lives in styles.css):
// HTTPS Certificate (read-only metadata + Rotate button), nginx Proxy (the
// six operator-settable directives: HTTPS port, HTTP/3, TLS protocols, HSTS,
// Prometheus allow-list, with a Save & Apply button), IPv6, Local Login Access (READ-ONLY here since 2026-09 — the editor moved to Users →
// Authentication → Settings, where it sits with the password and passkey
// policies; this card states the current scope and points there), and Trusted CAs.
// A drift banner appears above the deck, full width, when proxyConfig.managedMode
// is false (the refuse-and-banner UX for existing installs that haven't opted
// into Charon-managed nginx config yet). See src/api/routes/settings/webServer.ts.
function renderCertsTab(container) {
  var s = _httpsSettings || {};
  var p = (_proxyData && _proxyData.config) || {};
  var drift = (_proxyData && _proxyData.drift) || { managedMode: false, driftMarkers: [] };
  var fingerprint = (_proxyData && _proxyData.currentFingerprint) || s.fingerprint || "(unavailable)";
  var cn = s.cn || "(none)";
  var dnsSans = (s.dnsSans && s.dnsSans.length) ? s.dnsSans.join(", ") : "(none)";
  var ipSans = (s.ipSans && s.ipSans.length) ? s.ipSans.join(", ") : "(none)";
  var certPath = s.certPath || "(unset)";

  // Expiry with severity pill — amber <30d, red <7d, green otherwise.
  var expiryHtml = "(unknown)";
  var certEdge = "ok";
  if (s.expiresAt) {
    var ms = Date.parse(s.expiresAt) - Date.now();
    var days = Math.floor(ms / (24 * 60 * 60 * 1000));
    var pillClass = "badge-available";
    var pillLabel = days + " days";
    if (days < 0)       { pillClass = "badge-deprecated"; pillLabel = "EXPIRED"; certEdge = "red"; }
    else if (days < 7)  { pillClass = "badge-deprecated"; pillLabel = days + " days"; certEdge = "red"; }
    else if (days < 30) { pillClass = "badge-reserved";   pillLabel = days + " days"; certEdge = "amber"; }
    expiryHtml = escapeHtml(formatDate(s.expiresAt)) +
                 ' <span class="badge ' + pillClass + '" style="margin-left:6px">' +
                 escapeHtml(pillLabel) + '</span>';
  }

  // Drift banner — only renders when managedMode is false.
  var bannerHtml = "";
  if (!drift.managedMode) {
    var markers = (drift.driftMarkers || []).slice(0, 5).map(escapeHtml).join("; ");
    var moreCount = Math.max(0, (drift.driftMarkers || []).length - 5);
    var markerLine = markers
      ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.4rem;font-family:monospace">' +
          escapeHtml("Detected: ") + markers + (moreCount > 0 ? " (+" + moreCount + " more)" : "") +
        '</div>'
      : '';
    bannerHtml =
      '<div class="settings-card" style="border-color:#f59e0b;background:rgba(245,158,11,0.08);margin-bottom:1rem">' +
        '<h4 style="color:#f59e0b;margin-bottom:0.5rem">nginx config not Charon-managed yet</h4>' +
        '<p style="font-size:0.85rem;margin-bottom:0.6rem">' +
          'The Save &amp; Apply button below is disabled until you click <strong>Adopt managed mode</strong>. ' +
          'Until then, the controls show the values Charon would render into <code>/etc/nginx/conf.d/charon.conf</code> and ' +
          'are read-only. Adopting will overwrite any hand-edits beyond the six controls Charon manages on the ' +
          'next Apply.' +
        '</p>' +
        markerLine +
        '<div style="margin-top:0.8rem">' +
          '<button class="btn btn-sm btn-primary" id="proxy-adopt-btn">Adopt managed mode</button>' +
        '</div>' +
      '</div>';
  }

  var disabled = drift.managedMode ? "" : " disabled";
  var hsts = p.hsts || { enabled: true, maxAgeSeconds: 31536000, includeSubDomains: true, preload: true };
  var prom = (p.prometheusAllowIps || []).join("\n");
  var tlsProtocols = p.tlsProtocols || ["TLSv1.2", "TLSv1.3"];

  var certCardHtml =
    '<div class="settings-card severity-edge severity-edge-' + certEdge + '">' +
      '<h4>HTTPS Certificate</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'TLS is terminated by nginx reading the cert at <code>' + escapeHtml(certPath) + '</code>. ' +
        'Rotation walks through the dual-pin stage→swap→retire workflow so it\'s zero-downtime as long as ' +
        'every agent is online to receive the new pin. This certificate&rsquo;s SHA-256 fingerprint is the pin every ' +
        'Charon endpoint agent trusts (shown in the Rotate dialog).' +
      '</p>' +
      '<div class="form-group"><label>Cert path</label>' +
        '<input type="text" readonly value="' + escapeHtml(certPath) + '" style="font-family:monospace">' +
      '</div>' +
      '<div class="form-group"><label>Common Name</label>' +
        '<input type="text" readonly value="' + escapeHtml(cn) + '">' +
      '</div>' +
      '<div class="form-group"><label>DNS SANs</label>' +
        '<input type="text" readonly value="' + escapeHtml(dnsSans) + '">' +
      '</div>' +
      '<div class="form-group"><label>IP SANs</label>' +
        '<input type="text" readonly value="' + escapeHtml(ipSans) + '">' +
      '</div>' +
      '<div class="form-group"><label>Expiry</label>' +
        '<div style="padding:0.4rem 0">' + expiryHtml + '</div>' +
      '</div>' +
      '<div style="margin-top:0.5rem">' +
        '<button class="btn btn-sm btn-secondary" id="proxy-rotate-cert-btn">Rotate certificate</button>' +
      '</div>' +
    '</div>';

  var proxyCardHtml =
    '<div class="settings-card">' +
      '<h4>nginx Proxy</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Six operator-settable directives. Save &amp; Apply renders <code>/etc/nginx/conf.d/charon.conf</code> ' +
        'from these values, runs <code>nginx -t</code>, and reloads nginx. server_name is derived from ' +
        '<code>CHARON_PUBLIC_URL</code>. Charon serves TLS 1.3 only (PQC-hybrid key exchange).' +
      '</p>' +
      '<div class="form-group">' +
        '<label for="proxy-https-port">HTTPS listen port (TCP + UDP)</label>' +
        '<input type="number" id="proxy-https-port" min="1" max="65535" value="' + escapeHtml(String(p.httpsPort || 443)) + '"' + disabled + '>' +
      '</div>' +
      '<div class="form-group">' +
        '<label><input type="checkbox" id="proxy-http3-enabled"' + (p.http3Enabled ? " checked" : "") + disabled + '> HTTP/3 (QUIC over UDP)</label>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Requires nginx 1.30+. When off, removes the QUIC listener, the Alt-Svc header, and ssl_early_data.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>TLS protocols</label>' +
        '<div style="display:flex;gap:1rem">' +
          '<label><input type="checkbox" id="proxy-tls-12"' + (tlsProtocols.indexOf("TLSv1.2") >= 0 ? " checked" : "") + disabled + '> TLSv1.2</label>' +
          '<label><input type="checkbox" id="proxy-tls-13"' + (tlsProtocols.indexOf("TLSv1.3") >= 0 ? " checked" : "") + disabled + '> TLSv1.3</label>' +
        '</div>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">QUIC requires TLSv1.3 — turning HTTP/3 on auto-includes 1.3.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label><input type="checkbox" id="proxy-hsts-enabled"' + (hsts.enabled ? " checked" : "") + disabled + '> HSTS (Strict-Transport-Security header)</label>' +
        '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem">' +
          '<input type="number" id="proxy-hsts-max-age" min="0" value="' + escapeHtml(String(hsts.maxAgeSeconds)) + '" style="flex:1"' + disabled + '>' +
          '<select id="proxy-hsts-preset" style="flex:0 0 8rem"' + disabled + '>' +
            '<option value="">Preset…</option>' +
            '<option value="3600">1 hour</option>' +
            '<option value="86400">1 day</option>' +
            '<option value="2592000">30 days</option>' +
            '<option value="31536000">1 year</option>' +
          '</select>' +
        '</div>' +
        '<label style="margin-top:0.3rem"><input type="checkbox" id="proxy-hsts-subdomains"' + (hsts.includeSubDomains ? " checked" : "") + disabled + '> includeSubDomains</label> &nbsp; ' +
        '<label><input type="checkbox" id="proxy-hsts-preload"' + (hsts.preload ? " checked" : "") + disabled + '> preload</label>' +
        '<div style="font-size:0.78rem;color:#f59e0b;margin-top:0.3rem">HSTS cannot be undone in already-visited browsers for the duration of the previous max-age.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="proxy-prometheus-ips">Prometheus allow-list (one IP per line)</label>' +
        '<textarea id="proxy-prometheus-ips" rows="3" placeholder="10.0.0.42"' + disabled + '>' + escapeHtml(prom) + '</textarea>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Empty list = deny all. Bearer auth still gates /metrics; this is the first defense layer.</div>' +
      '</div>' +
      '<div style="margin-top:1rem">' +
        '<button class="btn btn-sm btn-primary" id="proxy-apply-btn"' + disabled + '>Save &amp; Apply</button>' +
        '<div id="proxy-apply-status" style="font-size:0.85rem;margin-top:0.6rem;display:none"></div>' +
        '<div id="proxy-apply-output" style="font-size:0.78rem;margin-top:0.4rem;display:none;background:var(--color-surface);padding:0.6rem;border-radius:4px;white-space:pre-wrap;font-family:monospace;max-height:14rem;overflow:auto"></div>' +
      '</div>' +
    '</div>';

  // IPv6 card — business rule 128. Off means no IPv6 is discovered, collected,
  // stored or shown anywhere. Set once at install from whether this server had
  // a routable IPv6 address; a plain toggle from then on. PUT is
  // serverSettingsSystem write-gated.
  var v6 = _ipv6Settings;
  var v6Hosts = (v6 && Array.isArray(v6.hostAddresses)) ? v6.hostAddresses : [];
  var v6Origin = !v6 ? '' :
    v6.setBy === "install"
      ? (v6.enabled
          ? 'Switched on at install, because this server had a routable IPv6 address.'
          : 'Switched off at install, because this server had no routable IPv6 address.')
      : v6.setBy === "operator" ? 'Set in Server Settings.' : '';
  var ipv6CardHtml =
    '<div class="settings-card">' +
      '<h4>IPv6</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'When IPv6 is off, Charon discovers, collects, stores and shows no IPv6 addresses, and every device is ' +
        'monitored on its IPv4 address. When it is on, a device with no IPv4 address is monitored on its primary IPv6 address, ' +
        'as long as this server can reach IPv6. Charon sets this once at install, from whether this server has a ' +
        'routable IPv6 address; after that only this switch changes it. In a container the server is the container: ' +
        'on Docker or podman compose, enable IPv6 on the compose network first (see the install guide).' +
      '</p>' +
      (v6 === null
        ? '<p style="font-size:0.85rem;color:var(--color-text-secondary)">Unavailable — could not load the IPv6 setting.</p>'
        : '<div class="form-group">' +
            '<label><input type="checkbox" id="ipv6-enabled"' + (v6.enabled ? " checked" : "") + '> Enable IPv6</label>' +
            (v6Origin ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">' + v6Origin + '</div>' : '') +
          '</div>' +
          (v6.enabled && !v6.dialable
            ? '<p style="font-size:0.82rem;color:#f59e0b;margin-bottom:0.75rem">This server has no IPv6 address or route, so it cannot reach IPv6 devices. ' +
                'IPv6 addresses are still discovered and shown, but a device with only an IPv6 address is not polled. ' +
                'In a container, enable IPv6 on the compose network.</p>'
            : '') +
          (!v6.enabled && v6Hosts.length
            ? '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">This server now has a routable IPv6 address. ' +
                'Turn IPv6 on to discover and monitor IPv6 devices.</p>'
            : '') +
          '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">This server\'s IPv6: ' +
            (v6Hosts.length
              ? '<code>' + v6Hosts.map(escapeHtml).join(", ") + '</code>'
              : 'none routable (link-local and loopback addresses are not counted)') +
          '</p>' +
          '<div style="margin-top:0.5rem"><button class="btn btn-sm btn-primary" id="ipv6-save-btn">Save</button></div>') +
    '</div>';

  var caCardHtml =
    '<div class="settings-card" style="display:flex;flex-direction:column">' +
      '<h4>Trusted Certificate Authorities</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">CA certificates used to verify remote servers when Charon connects to integrations (FortiGate, FortiManager, Entra ID), in addition to the system trust store.</p>' +
      '<ul class="cert-list" id="ca-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:auto;padding-top:1rem">' +
        '<div class="upload-area" id="ca-upload-area">' +
          '<input type="file" id="ca-file-input" accept=".pem,.crt,.cer,.der">' +
          '<strong style="color:var(--color-text-primary)">Upload CA Certificate</strong>' +
          '<p>Click to select a .pem, .crt, or .cer file</p>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Local Login Access — a POINTER, not an editor.
  //
  // The setting itself (`loginAccessConfig`) still exists and still gates
  // /login.html and the password endpoints; what moved (2026-09) is where it is
  // edited. It now lives on Users → Authentication → Settings beside the
  // password policy and the passkey policy, because "who may sign in, and how"
  // is one decision and having two screens that write the same row is how the
  // two drift into disagreeing about what is configured. Read-only status here
  // so an admin looking at Web Server still learns the answer.
  var la = _loginAccess;
  var laS = la && la.settings;
  var laSummary;
  if (la === null) {
    laSummary = 'Unavailable &mdash; could not load the login access settings.';
  } else if (!laS.enabled) {
    laSummary = 'Not restricted &mdash; local login is reachable from any network that can reach Charon.';
  } else if (laS.ipScope === "custom") {
    laSummary = 'Restricted to: <code>' + escapeHtml((laS.allowedCidrs || []).join(", ") || "(none)") + '</code>';
  } else if (laS.ipScope === "all") {
    laSummary = 'Scope set to all source IPs &mdash; effectively unrestricted.';
  } else {
    laSummary = 'Restricted to private networks (RFC1918) and loopback.';
  }
  var loginCardHtml =
    '<div class="settings-card">' +
      '<h4>Local Login Access</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
        'Restricts which source networks may reach the local login form at <code>/login.html</code> and submit ' +
        'a username and password. <strong>SAML, OIDC and App Proxy sign-in are never restricted</strong> &mdash; only the ' +
        'password path, which carries local <em>and</em> LDAP accounts.' +
      '</p>' +
      '<p style="font-size:0.85rem;margin-bottom:0.75rem"><strong>Current:</strong> ' + laSummary + '</p>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary)">' +
        'Edit this on <a href="/users.html">Users</a> &rarr; <strong>Authentication</strong> &rarr; <strong>Settings</strong>, ' +
        'where it sits with the password policy and passkey settings.' +
      '</p>' +
    '</div>';

  // Polaris's "Pinned server identities" card (rule 113 — TOFU pins for outbound
  // WinRM / SSH / FortiGate-with-verify-off) is not rendered: Charon keeps no
  // such pin store, and an always-empty list would read as protection that
  // does not exist. pinned-tls-certs.js stays loaded but is never mounted.

  container.innerHTML = bannerHtml +
    '<div class="settings-cards-flow">' +
      certCardHtml + proxyCardHtml + ipv6CardHtml + loginCardHtml + caCardHtml +
    '</div>';

  var adoptBtn = document.getElementById("proxy-adopt-btn");
  if (adoptBtn) adoptBtn.addEventListener("click", handleProxyAdopt);

  var ipv6SaveBtn = document.getElementById("ipv6-save-btn");
  if (ipv6SaveBtn) ipv6SaveBtn.addEventListener("click", function () { handleIpv6Save(container); });

  var rotateBtn = document.getElementById("proxy-rotate-cert-btn");
  if (rotateBtn) rotateBtn.addEventListener("click", openRotateCertModal);

  var presetSelect = document.getElementById("proxy-hsts-preset");
  if (presetSelect) {
    presetSelect.addEventListener("change", function () {
      if (this.value) {
        document.getElementById("proxy-hsts-max-age").value = this.value;
        this.value = "";
      }
    });
  }

  var http3Box = document.getElementById("proxy-http3-enabled");
  if (http3Box) {
    http3Box.addEventListener("change", function () {
      if (this.checked) {
        var tls13 = document.getElementById("proxy-tls-13");
        if (tls13) tls13.checked = true;
      }
    });
  }

  var applyBtn = document.getElementById("proxy-apply-btn");
  if (applyBtn) applyBtn.addEventListener("click", handleProxyApply);
}


async function handleIpv6Save(container) {
  var enabled = !!(document.getElementById("ipv6-enabled") || {}).checked;
  if (!enabled && _ipv6Settings && _ipv6Settings.enabled &&
      !(await showConfirm("Turn IPv6 off? Charon stops discovering and showing IPv6 addresses, and devices that only have an IPv6 address stop being polled."))) {
    return;
  }
  try {
    var result = await api.serverSettings.ipv6Put({ enabled: enabled });
    _ipv6Settings = (result && result.ipv6) || _ipv6Settings;
    showToast("IPv6 " + (_ipv6Settings && _ipv6Settings.enabled ? "on" : "off") + " — other pages pick it up when reloaded");
    renderCertsTab(container);
  } catch (err) {
    showToast("Failed to save the IPv6 setting: " + (err.message || err), "error");
  }
}

async function handleProxyAdopt() {
  if (!(await showConfirm("Adopt Charon-managed nginx config mode? Hand-edits beyond the six controls will be overwritten on the next Apply."))) return;
  try {
    await api.serverSettings.proxyAdoptManagedMode();
    await loadCertificates();
  } catch (err) {
    showToast("Failed to adopt managed mode: " + (err.message || err), "error");
  }
}

function readProxyFormValues() {
  var tlsProtocols = [];
  if (document.getElementById("proxy-tls-12").checked) tlsProtocols.push("TLSv1.2");
  if (document.getElementById("proxy-tls-13").checked) tlsProtocols.push("TLSv1.3");
  var ipsRaw = document.getElementById("proxy-prometheus-ips").value || "";
  var ips = ipsRaw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    httpsPort: parseInt(document.getElementById("proxy-https-port").value, 10),
    http3Enabled: document.getElementById("proxy-http3-enabled").checked,
    tlsProtocols: tlsProtocols,
    hsts: {
      enabled: document.getElementById("proxy-hsts-enabled").checked,
      maxAgeSeconds: parseInt(document.getElementById("proxy-hsts-max-age").value, 10) || 0,
      includeSubDomains: document.getElementById("proxy-hsts-subdomains").checked,
      preload: document.getElementById("proxy-hsts-preload").checked,
    },
    prometheusAllowIps: ips,
  };
}

async function handleProxyApply() {
  var btn = document.getElementById("proxy-apply-btn");
  var status = document.getElementById("proxy-apply-status");
  var outBox = document.getElementById("proxy-apply-output");
  var body = readProxyFormValues();
  btn.disabled = true;
  status.style.display = "block";
  status.style.color = "var(--color-text-secondary)";
  status.textContent = "Rendering and reloading nginx…";
  outBox.style.display = "none";
  outBox.textContent = "";
  try {
    var res = await api.serverSettings.proxyApply(body);
    if (res.ok) {
      status.style.color = "var(--color-text-secondary)";
      status.innerHTML =
        '<span style="color:#4ade80">✓</span> Applied (sha256=' + escapeHtml(res.hash.slice(0, 12)) + '…). ' +
        'If you changed the port, open TCP+UDP/<strong>' + escapeHtml(String(body.httpsPort)) + '</strong> in your firewall.';
      if (res.listening) {
        outBox.style.display = "block";
        outBox.textContent = res.listening;
      }
      setTimeout(loadCertificates, 800);
    } else {
      status.style.color = "#ef4444";
      status.textContent = "✗ Apply failed. nginx -t output below.";
      outBox.style.display = "block";
      outBox.textContent = res.wrapperOutput || "(no output)";
    }
  } catch (err) {
    status.style.color = "#ef4444";
    status.textContent = "✗ " + (err.message || "Apply failed");
  } finally {
    btn.disabled = false;
  }
}

// ─── Rotate certificate modal: dual-pin stage → swap → retire workflow ──────

function openRotateCertModal() {
  // Uses the canonical openModal() (.modal structure) so it picks up the shared
  // modal CSS, drag, scrim-close, and accessibility behavior — was previously a
  // hand-rolled .modal-overlay/.modal-content that the canonical styles didn't
  // reach.
  var body =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Four-step zero-downtime rotation: ' +
      '(1) upload the replacement pair; ' +
      '(2) stage the new pin on every active agent so they accept both old + new; ' +
      '(3) swap the cert file + reload nginx; ' +
      '(4) retire the old pin once you\'re confident every agent has reconnected.' +
    '</p>' +
    '<div class="form-group"><label for="rotate-cert-file">Certificate (.pem / .crt)</label>' +
      '<input type="file" id="rotate-cert-file" accept=".pem,.crt,.cer">' +
    '</div>' +
    '<div class="form-group"><label for="rotate-key-file">Private key (.pem / .key)</label>' +
      '<input type="file" id="rotate-key-file" accept=".pem,.key">' +
    '</div>' +
    '<div id="rotate-preflight" style="display:none;background:var(--color-surface);padding:0.8rem;border-radius:4px;margin-bottom:1rem;font-size:0.82rem"></div>' +
    '<div id="rotate-error" style="display:none;color:var(--color-danger);font-size:0.85rem;margin-bottom:1rem"></div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-secondary" id="rotate-preflight-btn">1. Preflight</button>' +
    '<button class="btn btn-secondary" id="rotate-stage-btn" disabled>2. Stage pin</button>' +
    '<button class="btn btn-primary" id="rotate-swap-btn" disabled>3. Swap cert</button>' +
    '<button class="btn btn-secondary" id="rotate-retire-btn" disabled>4. Retire old pin</button>';
  openModal("Rotate HTTPS certificate", body, footer, { wide: true });

  var state = { preflight: null, oldFingerprint: null };

  function showError(msg) {
    var box = document.getElementById("rotate-error");
    box.style.display = "block";
    box.textContent = msg;
  }
  function clearError() {
    document.getElementById("rotate-error").style.display = "none";
  }
  function updatePreflightDisplay(extraNote) {
    var box = document.getElementById("rotate-preflight");
    if (!state.preflight) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.innerHTML =
      '<div style="font-family:monospace;margin-bottom:0.4rem">' +
        '<strong>New fingerprint:</strong> ' + escapeHtml(state.preflight.newFingerprint) + '<br>' +
        '<strong>CN:</strong> ' + escapeHtml(state.preflight.newCn || "(none)") + '<br>' +
        '<strong>DNS SANs:</strong> ' + escapeHtml((state.preflight.newDnsSans || []).join(", ") || "(none)") + '<br>' +
        '<strong>Expiry:</strong> ' + escapeHtml(state.preflight.newExpiresAt ? formatDate(state.preflight.newExpiresAt) : "(unknown)") + '<br>' +
        '<strong>Current pin to retire:</strong> ' + escapeHtml(state.oldFingerprint || "(none)") +
      '</div>' +
      (extraNote || "");
  }

  document.getElementById("rotate-preflight-btn").addEventListener("click", async function () {
    clearError();
    var certFile = document.getElementById("rotate-cert-file").files[0];
    var keyFile = document.getElementById("rotate-key-file").files[0];
    if (!certFile || !keyFile) { showError("Select both a cert and key file."); return; }
    this.disabled = true;
    try {
      state.preflight = await api.serverSettings.proxyCertPreflight(certFile, keyFile);
      state.oldFingerprint = state.preflight.currentFingerprint;
      updatePreflightDisplay('<div style="color:#f59e0b">Click <strong>Stage pin</strong> next.</div>');
      document.getElementById("rotate-stage-btn").disabled = false;
    } catch (err) {
      showError(err.message || "Preflight failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-stage-btn").addEventListener("click", async function () {
    if (!state.preflight) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.agentCertPinBulkAdd(state.preflight.newFingerprint);
      updatePreflightDisplay(
        '<div style="color:#4ade80">✓ Staged on ' + escapeHtml(String(result.added)) +
        ' agent(s); ' + escapeHtml(String(result.alreadyPresent)) + ' already had the pin. ' +
        'Total active: ' + escapeHtml(String(result.totalActive)) + '. ' +
        'Agents pick up the new pin on their next /config poll. ' +
        'Verify uptake at <a href="#" id="rotate-summary-link">cert-pins summary</a> or just wait ~30s, ' +
        'then click <strong>Swap cert</strong>.</div>',
      );
      document.getElementById("rotate-summary-link").addEventListener("click", async function (ev) {
        ev.preventDefault();
        var summary = await api.serverSettings.agentCertPinsSummary();
        var entry = (summary.pins || []).find(function (p) { return p.pin === state.preflight.newFingerprint.toLowerCase(); });
        var have = entry ? entry.canonical + entry.staged : 0;
        showToast("Cert pin uptake: " + have + " / " + summary.totalActiveAgents + " active agents have the new pin.");
      });
      document.getElementById("rotate-swap-btn").disabled = false;
    } catch (err) {
      showError(err.message || "Stage failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-swap-btn").addEventListener("click", async function () {
    if (!state.preflight) return;
    if (!(await showConfirm("Swap the HTTPS certificate + key files and reload nginx? Make sure all active agents have heartbeated with the new pin staged."))) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.proxyCertRotate({
        certPem: state.preflight.certPem,
        keyPem: state.preflight.keyPem,
      });
      if (result.ok) {
        updatePreflightDisplay(
          '<div style="color:#4ade80">✓ Cert swapped + nginx reloaded. New fingerprint live. ' +
          // Charon: Docker/dev has no apply wrapper — say so instead of claiming a reload.
          (result.note ? '<div style="color:#f59e0b">' + escapeHtml(result.note) + '</div>' : '') +
          (state.oldFingerprint
            ? 'Click <strong>Retire old pin</strong> to remove <code>' + escapeHtml(state.oldFingerprint) + '</code> from every agent\'s accepted set.'
            : 'No previous pin recorded — nothing to retire.') +
          '</div>',
        );
        if (state.oldFingerprint) {
          document.getElementById("rotate-retire-btn").disabled = false;
        }
      } else {
        showError("Rotate failed. nginx output: " + (result.wrapperOutput || "(no output)"));
        this.disabled = false;
      }
    } catch (err) {
      showError(err.message || "Rotate failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-retire-btn").addEventListener("click", async function () {
    if (!state.oldFingerprint) return;
    if (!(await showConfirm("Retire the previous pin (" + state.oldFingerprint + ") from every active agent's accepted set? Skipped on any agent where it would be the last pin."))) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.agentCertPinBulkRemove(state.oldFingerprint);
      var msg = "Retired on " + result.removed + " agent(s)";
      if (result.lastPinSkipped > 0) msg += "; " + result.lastPinSkipped + " skipped (would have been last pin)";
      showToast(msg + ". Rotation complete.");
      closeModal();
      await loadCertificates();
    } catch (err) {
      showError(err.message || "Retire failed");
      this.disabled = false;
    }
  });
}

async function loadCertificates() {
  _certsLoaded = true;
  var container = document.getElementById("tab-certificates");

  try {
    _httpsSettings = await api.serverSettings.getHttps();
  } catch (_) {}

  try {
    _proxyData = await api.serverSettings.proxyGet();
  } catch (_) { _proxyData = null; }

  try {
    var v6Resp = await api.serverSettings.ipv6Get();
    _ipv6Settings = (v6Resp && v6Resp.ipv6) || null;
  } catch (_) { _ipv6Settings = null; }

  try {
    var laResp = await api.serverSettings.loginAccessGet();
    _loginAccess = laResp && laResp.loginAccess
      ? { settings: laResp.loginAccess, callerIp: laResp.callerIp || "" }
      : null;
  } catch (_) { _loginAccess = null; }

  renderCertsTab(container);
  wireUploadArea("ca-upload-area", "ca-file-input", uploadCA);
  await refreshCertLists();
}

function wireUploadArea(areaId, inputId, handler) {
  var area = document.getElementById(areaId);
  var input = document.getElementById(inputId);
  area.addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    if (input.files.length > 0) handler(Array.from(input.files));
    input.value = "";
  });
}

async function refreshCertLists() {
  try {
    _certData = await api.serverSettings.listCerts();
  } catch (_) {
    _certData = { trustedCAs: [], serverCerts: [] };
  }
  renderCAList();
}

function certIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
}

function renderCAList() {
  var list = document.getElementById("ca-list");
  if (!_certData.trustedCAs.length) {
    list.innerHTML = '<li class="cert-empty">No trusted CAs uploaded. Charon will use the system trust store.</li>';
    return;
  }
  list.innerHTML = _certData.trustedCAs.map(function (cert) {
    return '<li class="cert-item">' +
      '<div class="cert-icon">' + certIconSvg() + '</div>' +
      '<div class="cert-info">' +
        '<div class="cert-name">' + escapeHtml(cert.name) + '</div>' +
        '<div class="cert-meta">' + escapeHtml(cert.subject || "Unknown subject") +
          (cert.expiresAt ? ' &middot; Expires ' + formatDate(cert.expiresAt) : '') +
          ' &middot; Uploaded ' + formatDate(cert.uploadedAt) +
        '</div>' +
      '</div>' +
      '<div class="cert-actions">' +
        '<button class="btn btn-sm btn-danger" onclick="deleteCA(' + jsArg(cert.id) + ', ' + jsArg(cert.name) + ')">Remove</button>' +
      '</div>' +
    '</li>';
  }).join("");
}

async function uploadCA(files) {
  for (var i = 0; i < files.length; i++) {
    try {
      await api.serverSettings.uploadCert("ca", files[i]);
      showToast("CA certificate uploaded: " + files[i].name);
    } catch (err) {
      showToast("Failed to upload " + files[i].name + ": " + err.message, "error");
    }
  }
  await refreshCertLists();
}

async function deleteCA(id, name) {
  var ok = await showConfirm('Remove trusted CA "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteCert(id);
    showToast("CA removed");
    await refreshCertLists();
  } catch (err) {
    showToast(err.message, "error");
  }
}

