/**
 * public/js/settings-ui.js — the polaris app.js UI helpers the ported Server
 * Settings modules call (openModal / closeModal / showConfirm / buildOverlay,
 * slideovers, callouts, tag colors, formatDate), copied verbatim from polaris,
 * plus the user/permission globals polaris's app.js keeps — filled here from
 * Charon's GET /auth/me instead of polaris's own boot.
 *
 * Load order on server-settings.html: settings-api.js → folder-tabs.js →
 * panel-lock.js → app.js (Charon shell) → settings-ui.js → tab modules.
 * `window.__charonUserReady` resolves once the globals below are populated;
 * the tab modules wait on it before their first permission check.
 */

// ─── User + permission globals (polaris app.js shape, Charon source) ─────────
var currentUsername = null;
var currentUserRole = null;
var currentRolePermissions = {};
var currentUserAuthProvider = "local"; // how THIS session signed in: local / ldap / saml / oidc / entra-proxy / passkey

var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
function permLevel(key) { return currentRolePermissions[key] || "none"; }
function permAtLeast(key, level) {
  return (_PERM_RANK[permLevel(key)] || 0) >= (_PERM_RANK[level] || 0);
}
// Charon has no "admin" role string — roles are a dynamic matrix — so admin
// means admin-equivalent: full control of users and roles (the same predicate
// polaris's isAdminEquivalent() uses for admin-only overrides).
function isAdmin() { return permAtLeast("users", "fullwrite") && permAtLeast("roles", "fullwrite"); }
function isAdminEquivalent() { return isAdmin(); }
// Credentials carry the ownership dimension: write = your own rows only,
// fullwrite = any row. A null createdBy is UNOWNED and reachable only at
// fullwrite — same rule the server's assertOwnership applies.
function canEditCredential(cred) {
  if (permAtLeast("credentials", "fullwrite")) return true;
  if (!permAtLeast("credentials", "write")) return false;
  return !!(cred && cred.createdBy && cred.createdBy === currentUsername);
}

// Branding: polaris re-skins its sidebar here; Charon's sidebar is rendered by
// app.js, so this hands the payload to Charon.setBranding (which caches it and
// repaints the sidebar name/subtitle/logo) and keeps the document title in step.
var _branding = null;
function applyBranding(b) {
  _branding = b || _branding;
  if (!_branding) return;
  if (window.Charon && typeof window.Charon.setBranding === "function") window.Charon.setBranding(_branding);
  document.title = ((_branding.appName || "").trim() || "Charon") + " — Server Settings";
}

window.__charonUserReady = window.Charon.init().then(function (user) {
  if (!user) return user;
  currentUsername = user.username || null;
  currentUserRole = user.role || null;
  currentRolePermissions = user.permissions || {};
  currentUserAuthProvider = user.authProvider || "local";
  return user;
});

// ─── More polaris app.js helpers (verbatim), for the Users page ──────────────

function val(id) { return document.getElementById(id).value.trim(); }

/**
 * Reveal an overlay that animates in: add `.open` on the next animation frame
 * so the transition has a start state, with a timeout floor because
 * requestAnimationFrame does NOT fire in a hidden tab. Idempotent: whichever
 * fires first wins. `after` runs once, immediately after the class lands.
 */
function revealOverlay(el, after) {
  if (!el) return;
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    el.classList.add("open");
    if (typeof after === "function") after();
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}

// Inline style string for a role badge given its stored color — only the
// `--hue` of a `.hue-pill` (styles.css), so the caller's badge must carry that
// class. Returns "" when the color is missing/invalid so the caller can fall
// back to a neutral badge.
function roleBadgeStyleFromColor(color) {
  var m = /^#?([0-9a-fA-F]{6})$/.exec(String(color || "").trim());
  return m ? "--hue:#" + m[1] : "";
}

// A pleasant random `#rrggbb` for the new-role color picker default — random
// hue, fixed mid saturation/lightness so every default reads as a usable badge.
function randomRoleColor() {
  var h = Math.floor(Math.random() * 360), s = 0.62, l = 0.55;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + rgb.map(function (v) {
    return ("0" + Math.round((v + m) * 255).toString(16)).slice(-2);
  }).join("");
}

// Per-user page prefs (polaris table-sf.js's PolarisPrefs), under
// charon-prefs-<page>-<username>.
window.PolarisPrefs = window.PolarisPrefs || {
  save: function (page, username, obj) {
    if (!username) return;
    try { localStorage.setItem("charon-prefs-" + page + "-" + username, JSON.stringify(obj)); } catch (_) {}
  },
  load: function (page, username) {
    if (!username) return null;
    var raw;
    try { raw = localStorage.getItem("charon-prefs-" + page + "-" + username); } catch (_) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  },
};

// ─── polaris app.js helpers (verbatim) ────────────────────────────────────────

var _modalDrag = { active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };

// ─── Modal accessibility (focus trap + restore + Escape) ──────────────────────
// Shared helpers so every openModal / showConfirm caller gets dialog semantics,
// a Tab focus-trap, Escape-to-close, and focus restoration for free.
function _focusableIn(container) {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(container.querySelectorAll(sel))
    .filter(function (el) { return el.offsetParent !== null; });
}

// Trap Tab within `container`; call `onEscape` on Escape. Returns a teardown fn.
function _trapFocus(container, onEscape) {
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    var f = _focusableIn(container);
    if (!f.length) { e.preventDefault(); container.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  return function () { document.removeEventListener("keydown", onKey, true); };
}

function _focusFirstIn(container) {
  var f = _focusableIn(container);
  if (f.length) f[0].focus(); else container.focus();
}

var _modalReturnFocus = null;  // element refocused when the shared modal closes

var _modalKeyTeardown = null;  // active focus-trap teardown for the shared modal

var _modalStepKeyTeardown = null; // active stepper-key teardown for the shared modal

// True when `overlayEl` is the slide-over the operator is looking at: it is
// open, no other slide-over was opened after it (every .slideover-overlay is
// z-index 1050, so the later one in the DOM paints on top — see
// raiseSlideover; that is why no slide-over may carry a z-index of its own),
// and no modal is stacked over it. Escape and keyboard
// chords gate on this, so a key meant for the top panel never closes the one
// underneath.
function isTopmostSlideover(overlayEl) {
  if (!overlayEl || !overlayEl.classList || !overlayEl.classList.contains("open")) return false;
  var mo = document.getElementById("modal-overlay");
  if (mo && mo.classList.contains("open")) return false;
  var open = document.querySelectorAll(".slideover-overlay.open");
  return open.length > 0 && open[open.length - 1] === overlayEl;
}

// Escape closes `overlayEl`'s slide-over when it is the topmost layer — the
// one Escape handler every slide-over uses. Exactly one open slide-over is
// topmost when the key lands, so exactly one handler matches; it then stops
// the event, because once it has closed, the panel beneath IS topmost and a
// handler registered after this one would close that too — one keypress,
// two panels gone. Handlers registered earlier already ran and declined.
function wireSlideoverEscape(overlayEl, close) {
  if (!overlayEl || typeof close !== "function") return;
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!isTopmostSlideover(overlayEl)) return;
    e.stopImmediatePropagation();
    close();
  });
}

// Move a CLOSED slide-over overlay to the end of <body> before it opens, so it
// paints over every slide-over already open. The overlays are created once and
// kept, so DOM order is first-open order, not open order: a network panel
// opened early in a session and then re-opened from inside the asset panel
// would otherwise slide in BEHIND the panel that asked for it. A no-op for an
// open overlay (a panel pivoting in place must not be re-inserted under its
// own nested drilldowns) and for one with no slide-over after it.
function raiseSlideover(overlayEl) {
  if (!overlayEl || overlayEl.parentNode !== document.body) return;
  if (!overlayEl.classList.contains("slideover-overlay") || overlayEl.classList.contains("open")) return;
  var later = overlayEl.nextElementSibling;
  while (later) {
    if (later.classList && later.classList.contains("slideover-overlay")) { document.body.appendChild(overlayEl); return; }
    later = later.nextElementSibling;
  }
}

function sectionHeading(text) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;' +
    'color:var(--color-text-tertiary);margin-bottom:0.75rem">' + escapeHtml(text) + "</p>";
}

function formDivider() {
  return '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Compatibility / scope constraints stated UP FRONT — versions, on-prem vs
// cloud, what the integration will and won't reach. Bold the specific values.
function infoBox(html) {
  return '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);' +
    'border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);' +
    'border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;' +
    'color:var(--color-text-secondary);line-height:1.5">' + html + "</div>";
}

// Every highlighted note (security blast-radius warnings, tip/alternative
// boxes, permission requirements) renders through this one helper. `variant`
// selects the accent from real theme tokens (so it adapts across themes); the
// faint tint is derived from that same token via color-mix. `title` is the bold
// lead row (icon prepended automatically); `bodyHtml` is raw HTML as hint text.
var CALLOUT_VARIANTS = {
  warning: { color: "var(--color-warning)", icon: "&#9888;" },        // warning sign — security / silent-failure caveats
  tip:     { color: "var(--color-accent)", icon: "&#128161;" },       // light bulb — alternatives / suggestions
  note:    { color: "var(--color-text-secondary)", icon: "" },        // neutral informational
};

function calloutHTML(variant, title, bodyHtml) {
  var v = CALLOUT_VARIANTS[variant] || CALLOUT_VARIANTS.note;
  return '<div style="border-left:3px solid ' + v.color + ';' +
      'background:color-mix(in srgb, ' + v.color + ' 9%, transparent);' +
      'border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:0.6rem 0.8rem;margin-top:0.75rem">' +
      (title
        ? '<p style="margin:0 0 0.4rem 0;font-weight:600;color:' + v.color + '">' +
            (v.icon ? v.icon + " " : "") + title + '</p>'
        : '') +
      '<p class="hint" style="margin:0">' + bodyHtml + '</p>' +
    '</div>';
}

function openModal(title, bodyHTML, footerHTML, options) {
  let overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><div class="modal-header"><h3 id="modal-title"></h3><button class="btn-icon modal-close" aria-label="Close dialog">&times;</button></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Locked → keep the dialog open (flash the X as a hint); unlocked →
        // an off-click dismisses it. See "Panel lock" above.
        if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
          flashModalCloseBtn(overlay.querySelector(".modal-close"));
        } else {
          closeModal();
        }
      }
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
    var modalEl = overlay.querySelector(".modal");
    var headerEl = overlay.querySelector(".modal-header");
    // The move cursor rides on the wiring, not on .modal-header itself: a
    // modal that builds its own overlay gets no drag handler, and a bare CSS
    // rule was advertising one to every such dialog (the Device Map topology
    // modal most visibly). If you wire drag on another header, set this there.
    headerEl.classList.add("is-draggable");
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.closest(".modal-close") || e.target.closest(".panel-lock-btn")) return;
      _modalDrag.active = true;
      _modalDrag.startX = e.clientX - _modalDrag.offsetX;
      _modalDrag.startY = e.clientY - _modalDrag.offsetY;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!_modalDrag.active) return;
      _modalDrag.offsetX = e.clientX - _modalDrag.startX;
      _modalDrag.offsetY = e.clientY - _modalDrag.startY;
      modalEl.style.transform = "translate(" + _modalDrag.offsetX + "px, " + _modalDrag.offsetY + "px)";
    });
    document.addEventListener("mouseup", function () {
      if (_modalDrag.active) {
        _modalDrag.active = false;
        document.body.style.userSelect = "";
      }
    });
  }
  var modal = overlay.querySelector(".modal");
  _modalDrag.offsetX = 0;
  _modalDrag.offsetY = 0;
  modal.style.transform = "";
  modal.classList.remove("modal-wide", "modal-large", "modal-xl");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.large) modal.classList.add("modal-large");
  if (options && options.xl) modal.classList.add("modal-xl");
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  var slideoverOpen = !!document.querySelector(".slideover-overlay.open");
  overlay.classList.toggle("above-slideover", slideoverOpen);
  if (typeof initPanelLock === "function") {
    initPanelLock();
    _injectPanelLockButtons();
  }
  // Remember what had focus so closeModal can restore it; trap Tab + Escape
  // inside the dialog while it's open.
  _modalReturnFocus = document.activeElement;
  if (_modalKeyTeardown) { _modalKeyTeardown(); }
  _modalKeyTeardown = _trapFocus(modal, closeModal);
  // The previous occupant of this overlay may have been a wizard; its stepper
  // keys must not survive into a dialog whose footer means something else.
  if (_modalStepKeyTeardown) { _modalStepKeyTeardown(); _modalStepKeyTeardown = null; }
  // rAF so the transition has a start state to animate from — but rAF does
  // NOT fire in a hidden tab, which would leave the dialog built and invisible
  // until the tab is next looked at. The timeout is the floor; `reveal` is
  // idempotent so whichever fires first wins.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(modal);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.classList.remove("above-slideover");
  }
  if (_modalKeyTeardown) { _modalKeyTeardown(); _modalKeyTeardown = null; }
  if (_modalStepKeyTeardown) { _modalStepKeyTeardown(); _modalStepKeyTeardown = null; }
  if (_modalReturnFocus && typeof _modalReturnFocus.focus === "function") {
    try { _modalReturnFocus.focus(); } catch (_) { /* element gone */ }
  }
  _modalReturnFocus = null;
  if (typeof _modalFlashResetTimer !== "undefined" && _modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  if (typeof _modalFlashLevel !== "undefined") _modalFlashLevel = 0;
}

/**
 * Build a dismissible overlay ABOVE any open modal — the stacked-modal pattern.
 * Returns { overlay, dialog, close }; `onClose` fires for backdrop click,
 * Escape and the close button.
 *
 * Why this exists rather than calling openModal: openModal creates and then
 * REUSES one shared #modal-overlay, overwriting its .modal-body innerHTML — so
 * calling it from inside an open modal destroys that modal's form DOM and loses
 * whatever the operator had typed. Layer rungs: 1300 over a base modal, 1320
 * when a third layer must sit over the second.
 *
 * Lives here (rather than in the file that first needed it) because every
 * dependency is in app.js and app.js loads on every page: the automations code
 * editor opens from the wizard, which loads on five pages, only one of which
 * loads the address book.
 */
function buildOverlay(z, title, bodyHtml, footerHtml, onClose, wide) {
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.zIndex = String(z);
  overlay.innerHTML =
    '<div class="modal' + (wide ? " modal-large" : " modal-wide") + '" role="dialog" aria-modal="true" tabindex="-1">' +
      '<div class="modal-header"><h3>' + escapeHtml(title) + '</h3>' +
        '<button class="btn-icon modal-close" type="button" aria-label="Close dialog">&times;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' + footerHtml + '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var dialog = overlay.querySelector(".modal");
  var prevFocus = document.activeElement;
  var closed = false;
  var teardownTrap = _trapFocus(dialog, function () { close(); });

  function close() {
    if (closed) return;
    closed = true;
    teardownTrap();
    overlay.classList.remove("open");
    // Remove on transition end, with a timer fallback for reduced-motion.
    overlay.addEventListener("transitionend", function () {
      if (overlay.parentNode) overlay.remove();
    }, { once: true });
    setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
    if (prevFocus && typeof prevFocus.focus === "function") { try { prevFocus.focus(); } catch (_) {} }
    if (onClose) onClose();
  }

  // Panel lock: one global switch governs EVERY modal, so these stacked
  // overlays take the same toggle app.js injects into the shared #modal-overlay
  // (its MutationObserver only looks at that one element, hence the direct
  // call) and honor it the same way — an off-click while locked flashes the X
  // + bloom instead of dismissing. Guarded so the module still works on a page
  // that somehow loads without app.js.
  var closeBtn = overlay.querySelector(".modal-close");
  if (typeof _ensureLockButton === "function") {
    _ensureLockButton(overlay.querySelector(".modal-header"), "modal");
  }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", function (ev) {
    if (ev.target !== overlay) return;
    if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
      if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
      return;
    }
    close();
  });
  // See openModal: rAF alone never fires in a hidden tab.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(dialog);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);

  return { overlay: overlay, dialog: dialog, close: close };
}

function showConfirm(message) {
  return new Promise(function (resolve) {
    // Build a dedicated overlay rather than reusing openModal's single shared
    // #modal-overlay. openModal overwrites that element's body/footer innerHTML,
    // so calling it while another modal is open (e.g. the Edit Integration
    // auto-monitor guards) would destroy that modal's form DOM. A standalone
    // overlay at a higher z-index STACKS above any open modal, leaving its
    // markup intact so a save flow can still read the form after the confirm
    // resolves. white-space:pre-wrap preserves \n line breaks in the message.
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Confirm" tabindex="-1">' +
        '<div class="modal-header"><h3>Confirm</h3></div>' +
        '<div class="modal-body"><p style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap"></p></div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-confirm="cancel">Cancel</button>' +
          '<button class="btn btn-danger" data-confirm="ok">Confirm</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector(".modal-body p").textContent = message;
    document.body.appendChild(overlay);
    var dialog = overlay.querySelector(".modal");
    var cancelBtn = overlay.querySelector('[data-confirm="cancel"]');
    var okBtn = overlay.querySelector('[data-confirm="ok"]');
    var prevFocus = document.activeElement;
    var settled = false;
    var teardownTrap = _trapFocus(dialog, function () { done(false); });
    function done(val) {
      if (settled) return;
      settled = true;
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      // Fallback in case the transition doesn't fire (reduced-motion, etc.).
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }
    cancelBtn.onclick = function () { done(false); };
    okBtn.onclick = function () { done(true); };
    // Keyboard: Enter confirms, Escape cancels (`_trapFocus` wires Escape).
    // Confirm also TAKES focus on open, so the default action is the one the
    // operator can see is default — but Enter is handled here rather than left
    // to the focused button, so it still confirms if anything on the page has
    // stolen focus back.
    //
    // Two things this must not do. An operator who Tabs to Cancel and presses
    // Enter cancels: that key belongs to the button they chose. And an
    // auto-REPEATING Enter is swallowed outright, because these dialogs open
    // from row menus whose items are themselves activated with Enter — the
    // repeat of that same keypress lands on a button that appeared mid-press,
    // and a held key must never confirm a destructive act nobody has read.
    dialog.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      if (e.repeat) { e.preventDefault(); return; }
      if (e.target === cancelBtn) return;
      e.preventDefault();
      done(true);
    });
    // See openModal: rAF alone never fires in a hidden tab.
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      try { okBtn.focus(); } catch (_) { _focusFirstIn(dialog); }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  var d = new Date(dateStr);
  var base = { month: "short", day: "numeric", year: "numeric" };
  try {
    return d.toLocaleDateString(undefined, Object.assign({}, base, timeZoneOpts()));
  } catch (_) {
    // A stored zone this browser's ICU can't apply — the browser's own beats
    // rendering nothing.
    return d.toLocaleDateString(undefined, base);
  }
}

function randomTagColor() {
  var palette = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
  return palette[Math.floor(Math.random() * palette.length)];
}

// A tag's stored color is either a hex or a SEVERITY REFERENCE ("severity:warning").
// A reference resolves to the same theme token the severity bands paint with
// (PolarisChartSeverity's SEV_COLOR — keep the two maps in step), so a Priority tag
// reads exactly as its severity does on every theme. A fixed hex cannot: the
// --color-sev-* palette is retuned per theme (styles.css :root + daylight block).
var TAG_SEVERITY_COLORS = {
  notice: "var(--color-sev-notice)",
  informational: "var(--color-sev-informational)",
  warning: "var(--color-sev-warning)",
  serious: "var(--color-sev-serious)",
  critical: "var(--color-sev-critical)",
};

/** The severity a stored tag color references, or null for a plain hex. */
function tagColorSeverity(color) {
  var m = /^severity:([a-z]+)$/.exec(String(color || ""));
  return m && TAG_SEVERITY_COLORS[m[1]] ? m[1] : null;
}

/** A stored tag color as a CSS color — a hex, or the severity's theme token.
 *  Anything else (a malformed value) comes back empty so no caller writes it
 *  into a style attribute. */
function tagColorCss(color) {
  var sev = tagColorSeverity(color);
  if (sev) return TAG_SEVERITY_COLORS[sev];
  return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(String(color || "")) ? color : "";
}

/** The inline half of a `.hue-pill` (styles.css) for a tag colour: just the
 *  `--hue` custom property, or "" when the colour is unusable. Fill, label and
 *  border all come from the class, which clamps the label's lightness per theme
 *  — never write a stored colour into a chip's `color:` directly, because a
 *  pale one (yellow, white) vanishes on daylight and a deep one on nightfall. */
function tagHueStyle(color) {
  var css = tagColorCss(color);
  return css ? "--hue:" + css : "";
}

function initSlideoverResize(panelEl, storageKey) {
  var handle = panelEl.querySelector(".slideover-resize-handle");
  if (!handle) return;

  var stored = 0;
  try { stored = parseInt(localStorage.getItem(storageKey) || "0", 10); } catch (_) {}
  if (stored >= 380) panelEl.style.width = stored + "px";

  var minW = 380;
  function maxW() { return Math.round(window.innerWidth * 0.9); }

  // The grip: a chip centred on the bar, the slide-over's twin of the Device
  // Map topology pane's edge arrow. Dragging it resizes like the bar; a click
  // without a drag toggles the panel between its own width and the widest it
  // goes, and back. The expanded width is not saved — the stored width stays
  // the operator's dragged one.
  var grip = handle.querySelector(".slideover-resize-grip");
  if (!grip) {
    grip = document.createElement("button");
    grip.type = "button";
    grip.className = "slideover-resize-grip";
    grip.innerHTML = '<span class="slideover-resize-grip-arrow" aria-hidden="true"></span>';
    handle.appendChild(grip);
  }
  function syncGrip() {
    var expanded = panelEl.classList.contains("slideover-expanded");
    grip.title = expanded ? "Restore width (drag to resize)" : "Widen (drag to resize)";
    grip.setAttribute("aria-label", expanded ? "Restore panel width" : "Widen panel");
    grip.setAttribute("aria-pressed", expanded ? "true" : "false");
  }
  syncGrip();

  var moved = false;
  grip.addEventListener("click", function (e) {
    e.stopPropagation();
    if (moved) return;   // the end of a drag, not a click
    if (panelEl.classList.contains("slideover-expanded")) {
      panelEl.classList.remove("slideover-expanded");
      panelEl.style.width = panelEl.dataset.widthBeforeExpand || "";
    } else {
      panelEl.dataset.widthBeforeExpand = panelEl.style.width || "";
      panelEl.classList.add("slideover-expanded");
      panelEl.style.width = maxW() + "px";
    }
    syncGrip();
  });

  handle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    handle.classList.add("dragging");
    var panelRight = panelEl.getBoundingClientRect().right;
    var startX = e.clientX;
    var limit = maxW();
    moved = false;

    function onMove(e) {
      if (Math.abs(e.clientX - startX) > 3) moved = true;
      if (!moved) return;
      var w = Math.max(minW, Math.min(limit, Math.round(panelRight - e.clientX)));
      panelEl.style.width = w + "px";
    }

    function onUp(e) {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) return;
      // A drag ends the expanded state: the panel is now the width dragged to.
      panelEl.classList.remove("slideover-expanded");
      syncGrip();
      var w = Math.max(minW, Math.min(limit, Math.round(panelRight - e.clientX)));
      try { localStorage.setItem(storageKey, w); } catch (_) {}
      // Grace period. A fast drag outruns the repaint, so the button often
      // comes up over the dimmed backdrop rather than the bar. The browser
      // then sends a click to the nearest element under both the press and the
      // release — the overlay — and every slide-over closes on an overlay
      // click. Swallow clicks for a moment after a drag so letting go never
      // closes the panel.
      var until = Date.now() + 400;
      function swallow(ev) {
        if (Date.now() > until) { window.removeEventListener("click", swallow, true); return; }
        ev.stopPropagation();
        ev.preventDefault();
        window.removeEventListener("click", swallow, true);
      }
      window.addEventListener("click", swallow, true);
      setTimeout(function () { window.removeEventListener("click", swallow, true); }, 450);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
