/**
 * public/js/app.js — Charon dashboard shell.
 *
 * Emits the SAME sidebar DOM structure polaris uses (`.sidebar-brand`,
 * `.sidebar-nav`, `.sidebar-bottom-link`, `.theme-band`) so the copied polaris
 * `styles.css` themes it identically. Charon nav + permission gating comes from
 * GET /auth/me. Also provides the shared toast, the polaris theme dial,
 * escapeHtml, and `Charon.{init,toast,escapeHtml,can,isLightTheme}` used by
 * every page.
 */
(function () {
  "use strict";

  var currentUser = null;
  var RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };

  // ─── Theme ─────────────────────────────────────────────────────────────────
  //
  // Polaris's theme system, ported from polaris public/js/app.js. styles.css
  // (a verbatim copy) holds the token blocks, the crossfade, the page glows and
  // the .theme-band styles; theme-init.js applies the saved theme before first
  // paint. The view-transition type names stay "polaris-theme*" because the
  // copied stylesheet keys on them.
  //
  // Three SELECTABLE themes in two families: `nightfall` is dark, `morning`/
  // `noon` share the daylight overrides. Listed in day order, which is the
  // order the band steps through them. The retired `dark`/`light` ids fall
  // through to DEFAULT_THEME.
  //
  // Adding a theme = one entry here, one position in THEME_BAND_POS, one token
  // block in styles.css (i.e. in polaris first), one id in theme-init.js's KNOWN.
  var THEMES = [
    { id: "morning",   label: "Morning",   family: "light" },
    { id: "noon",      label: "Noon",      family: "light" },
    { id: "nightfall", label: "Nightfall", family: "dark" },
  ];
  // Transit palettes: real token blocks nothing can select. advanceTheme()
  // fades THROUGH each one on the way, so noon → nightfall crosses the golden
  // hour. Never persisted.
  var TRANSIT_THEMES = [
    { id: "afternoon", label: "Afternoon", family: "light", transit: true },
  ];
  // Where each palette sits along the strip art, as a fraction of its width
  // (a 24-hour clock unrolled: sun face = noon, moon face = nightfall). Each
  // palette was sampled from its own position, so these must match polaris.
  var THEME_BAND_POS = { noon: 0.056, afternoon: 0.306, nightfall: 0.556, morning: 0.806 };
  var THEME_BAND_ART = "/img/brand/time-strip-desktop.webp";
  // Intrinsic size, written onto each <img> so the band can be measured and
  // seated in the first paint, before the image decodes.
  var THEME_BAND_ART_W = 1676, THEME_BAND_ART_H = 64;
  var THEME_STORAGE_KEY = "charon-theme";
  var DEFAULT_THEME = "nightfall";

  // SELECTABLE ids only — a saved "afternoon" is rejected like a retired "dark".
  function themeExists(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
    return false;
  }
  // The record for `id` (selectable or transit), or DEFAULT_THEME's.
  function getThemeRec(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    for (var j = 0; j < TRANSIT_THEMES.length; j++) if (TRANSIT_THEMES[j].id === id) return TRANSIT_THEMES[j];
    for (var k = 0; k < THEMES.length; k++) if (THEMES[k].id === DEFAULT_THEME) return THEMES[k];
    return THEMES[0];
  }
  function currentThemeId() {
    return document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
  }
  // True for the daylight family. Use this, never an id compare, anywhere a
  // surface picks an image or a chart palette by brightness.
  function isLightTheme(id) {
    return getThemeRec(id || currentThemeId()).family === "light";
  }

  // theme-init.js already applied a theme; re-resolve here only to catch a
  // page that skipped it.
  if (!themeExists(document.documentElement.getAttribute("data-theme"))) {
    var savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) {}
    if (!themeExists(savedTheme)) savedTheme = null;
    var osLight = false;
    try { osLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    document.documentElement.setAttribute("data-theme", savedTheme || (osLight ? "morning" : DEFAULT_THEME));
  }

  // Where the band is now, in strip widths. May exceed 1 between a leg landing
  // and the seam being normalised away. null until first paint.
  var bandPos = null;
  var bandSeamTimer = null;

  // Writes bandPos to every band on the page. `animate` false parks it with
  // the transition suppressed (first paint, the seam jump, resize).
  function paintThemeBands(animate) {
    var tracks = document.querySelectorAll(".theme-band-track");
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var copy = track.firstElementChild;
      var win = track.parentElement;
      if (!copy || !win) continue;
      // Measured, not assumed: the rendered width depends on the band's height
      // and the pixel ratio. Before the art loads there is nothing to measure,
      // so seat on load; a hidden sidebar is caught by the resize listener.
      var stripW = copy.getBoundingClientRect().width;
      if (!stripW) {
        if (!copy.complete) copy.addEventListener("load", function () { paintThemeBands(false); }, { once: true });
        continue;
      }
      // Anchored one strip width left: copy two sits under the centre and
      // copies one and three cover the window either side.
      var x = win.getBoundingClientRect().width / 2 - (bandPos + 1) * stripW;
      if (animate) {
        track.style.transform = "translateX(" + x + "px)";
      } else {
        var prev = track.style.transition;
        track.style.transition = "none";
        track.style.transform = "translateX(" + x + "px)";
        void track.offsetWidth;
        track.style.transition = prev;
      }
    }
  }

  // Parks every band at the current position (or the current theme's) with no
  // animation. renderNav rebuilds the rail, so every render calls this.
  function seatThemeBands() {
    if (bandPos === null) bandPos = THEME_BAND_POS[currentThemeId()];
    if (bandPos === undefined) bandPos = THEME_BAND_POS[DEFAULT_THEME];
    paintThemeBands(false);
  }

  // Travels to `id`'s position, always forward (leftward); a target "behind"
  // is reached by running into the next identical copy of the strip.
  function advanceThemeBands(id, prevId) {
    var target = THEME_BAND_POS[id];
    if (target === undefined) return;
    if (bandSeamTimer) {
      // A seam normalisation still owed from the previous leg: settle it first.
      clearTimeout(bandSeamTimer);
      bandSeamTimer = null;
      if (bandPos !== null && bandPos >= 1) { bandPos -= 1; paintThemeBands(false); }
    }
    if (bandPos === null) {
      var seat = THEME_BAND_POS[prevId];
      bandPos = seat === undefined ? target : seat;
      paintThemeBands(false);
      if (seat === undefined) return;
    }
    var forward = target - bandPos;
    while (forward <= 0) forward += 1;
    bandPos += forward;
    paintThemeBands(true);
    if (bandPos >= 1) {
      // Exactly one strip width can be subtracted unseen once the leg lands —
      // never mid-transition.
      bandSeamTimer = setTimeout(function () {
        bandSeamTimer = null;
        bandPos -= 1;
        paintThemeBands(false);
      }, themeLegMs(id));
    }
  }

  if (!window.__charonBandResize) {
    window.__charonBandResize = true;
    window.addEventListener("resize", function () { if (bandPos !== null) paintThemeBands(false); });
  }

  // Matches the crossfade duration in styles.css (the data-theme-fading block).
  var THEME_FADE_MS = 800;
  // Steps longer than THEME_FADE_MS, by destination (styles.css carries the
  // same 1.6 s on [data-theme="morning"]).
  var THEME_LEG_MS = { morning: 1600 };
  function themeLegMs(id) { return THEME_LEG_MS[id] || THEME_FADE_MS; }
  var themeFadeTimer = null;

  // The page glows run on their own 2 s clock (styles.css); data-glow-turn
  // names the turn ("morning-noon") for that long.
  var GLOW_MS = 2000;
  var glowTurnTimer = null;
  function markGlowTurn(fromId, toId) {
    var root = document.documentElement;
    root.setAttribute("data-glow-turn", fromId + "-" + toId);
    if (glowTurnTimer) clearTimeout(glowTurnTimer);
    glowTurnTimer = setTimeout(function () {
      root.removeAttribute("data-glow-turn");
      glowTurnTimer = null;
    }, GLOW_MS + 80);
  }

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  // A same-document view transition WITH types crossfades the page as one
  // picture; anything else takes the per-element crossfade (data-theme-xfade).
  function themeViewTransitions() {
    try {
      return typeof document.startViewTransition === "function" &&
        typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype;
    } catch (e) { return false; }
  }

  // Arms the palette crossfade for one change, before data-theme moves.
  function beginThemeFade(phase, ms, viaViewTransition) {
    if (prefersReducedMotion()) return;
    var root = document.documentElement;
    root.setAttribute("data-theme-fading", phase || "solo");
    if (viaViewTransition) root.removeAttribute("data-theme-xfade");
    else root.setAttribute("data-theme-xfade", "");
    if (themeFadeTimer) clearTimeout(themeFadeTimer);
    themeFadeTimer = setTimeout(function () {
      root.removeAttribute("data-theme-fading");
      root.removeAttribute("data-theme-xfade");
      themeFadeTimer = null;
    }, (ms || THEME_FADE_MS) + 80);
  }

  // Applies a theme. `phase` positions it within a multi-leg turn: "solo",
  // "in", "mid", "out" (the data-theme-fading block in styles.css).
  function setTheme(theme, phase) {
    var t = getThemeRec(theme);
    var prevId = currentThemeId();
    var change = t.id !== prevId;
    var legMs = themeLegMs(t.id);
    var viaVT = change && !prefersReducedMotion() && themeViewTransitions();
    if (change) { beginThemeFade(phase, legMs, viaVT); markGlowTurn(prevId, t.id); }
    if (viaVT) {
      document.startViewTransition({
        update: function () { applyTheme(t, prevId); },
        types: ["polaris-theme", "polaris-theme-" + (phase || "solo"),
                legMs > THEME_FADE_MS ? "polaris-theme-slow" : "polaris-theme-std"],
      });
    } else {
      applyTheme(t, prevId);
    }
  }

  // The DOM half of setTheme, split out so a view transition can run it as its
  // update callback.
  var applyingTheme = false;
  function applyTheme(t, prevId) {
    applyingTheme = true;
    document.documentElement.setAttribute("data-theme", t.id);
    applyingTheme = false;
    // Waypoints are never saved: a reload mid-turn must land on a real theme.
    if (!t.transit) { try { localStorage.setItem(THEME_STORAGE_KEY, t.id); } catch (e) {} }
    // The band is TRANSFORMED, never rebuilt — re-rendering would snap it.
    advanceThemeBands(t.id, prevId);
    // The aria-label is the ONLY place the theme is named; keep it current.
    var bands = document.querySelectorAll(".theme-band");
    for (var i = 0; i < bands.length; i++) {
      bands[i].setAttribute("aria-label", "Time of day: " + t.label + ". Move through the day.");
    }
    // Anything that cached colors at render time listens for this.
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t.id, family: t.family } }));
  }

  // A theme set by other means — theme-init.js following the OS, for a user
  // with nothing saved — moves no band of its own: re-seat it, unanimated.
  try {
    new MutationObserver(function () {
      if (applyingTheme || themeChainTimer || document.documentElement.hasAttribute("data-theme-fading")) return;
      var pos = THEME_BAND_POS[currentThemeId()];
      if (pos === undefined) return;
      bandPos = pos;
      paintThemeBands(false);
      var t = getThemeRec(currentThemeId());
      document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t.id, family: t.family } }));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  } catch (e) { /* no MutationObserver — the band catches up on the next render */ }

  // Forward distance from `a` to `b` in the band's direction of travel, 0–1.
  function bandForwardGap(a, b) { return ((b - a) % 1 + 1) % 1; }

  // Where the band is headed: a click mid-sweep steps on from the DESTINATION,
  // not from the waypoint currently painted.
  var themeDest = null;
  var themeChainTimer = null;

  // One click, one step — landing only on THEMES entries, fading through any
  // TRANSIT_THEMES position on the way as one continuous sweep.
  function advanceTheme() {
    if (themeChainTimer) { clearTimeout(themeChainTimer); themeChainTimer = null; }
    var from = themeDest || currentThemeId();
    var i = THEMES.indexOf(getThemeRec(from));
    var dest = THEMES[(i + 1) % THEMES.length].id;

    var a = THEME_BAND_POS[from] || 0;
    var span = bandForwardGap(a, THEME_BAND_POS[dest] || 0) || 1;
    var stops = TRANSIT_THEMES
      .filter(function (t) {
        var d = bandForwardGap(a, THEME_BAND_POS[t.id] || 0);
        return d > 0 && d < span;
      })
      .sort(function (x, y) {
        return bandForwardGap(a, THEME_BAND_POS[x.id] || 0) - bandForwardGap(a, THEME_BAND_POS[y.id] || 0);
      })
      .map(function (t) { return t.id; });

    themeDest = dest;
    var queue = stops.concat([dest]);
    var legs = queue.length;
    var n = 0;
    (function step() {
      var phase = legs === 1 ? "solo" : (n === 0 ? "in" : (n === legs - 1 ? "out" : "mid"));
      n++;
      var leg = queue.shift();
      setTheme(leg, phase);
      if (!queue.length) { themeDest = null; themeChainTimer = null; return; }
      themeChainTimer = setTimeout(step, themeLegMs(leg));
    })();
  }

  // Delegated, so a band rendered by any renderNav travels without being wired
  // up. Never add a direct listener to a .theme-band too, or one click
  // advances two steps.
  if (!document.documentElement.hasAttribute("data-theme-band-wired")) {
    document.documentElement.setAttribute("data-theme-band-wired", "");
    document.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest(".theme-band")) advanceTheme();
    });
  }

  // The band: no caption and no marker — the art under the centre is the
  // answer, which is why the aria-label is the only place the theme is named.
  // The art is repeated THREE times on purpose (see paintThemeBands). The track
  // carries no position here; seatThemeBands() places it after insertion.
  function themeBandHtml() {
    var img = '<img src="' + THEME_BAND_ART + '" width="' + THEME_BAND_ART_W + '" height="' + THEME_BAND_ART_H + '" decoding="sync" alt="" draggable="false">';
    return '<button type="button" id="btn-theme-band" class="theme-band" aria-label="Time of day: ' +
      escapeHtml(getThemeRec(currentThemeId()).label) + '. Move through the day.">' +
      '<span class="theme-band-window"><span class="theme-band-track" id="theme-band-track">' + img + img + img + "</span></span></button>";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function csrfHeaders(extra) {
    var h = extra || {};
    var c = readCookie("charon_csrf");
    if (c) h["X-CSRF-Token"] = c;
    return h;
  }

  // ─── Toast (polaris .toast-container / .toast) ───────────────────────────────
  function toast(msg, kind) {
    var c = document.querySelector(".toast-container");
    if (!c) { c = document.createElement("div"); c.className = "toast-container"; document.body.appendChild(c); }
    var t = document.createElement("div");
    t.className = "toast " + (kind === "error" ? "toast-error" : kind === "success" ? "toast-success" : "");
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  // ─── User badge (top-right of the page header) ───────────────────────────────
  function getInitials(name) {
    if (!name) return "?";
    var parts = name.replace(/[._@-]/g, " ").trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  }
  function initialsColor(name) {
    var hash = 0;
    for (var i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    var colors = ["#4a9eff", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#fb923c", "#38bdf8", "#4ade80"];
    return colors[Math.abs(hash) % colors.length];
  }
  // Short label + pill color per built-in role (matches the seeded role colors).
  var ROLE_LABEL = { Administrator: "Admin", Operator: "Operator", "Read-Only": "Read-Only" };
  var ROLE_COLOR = { Administrator: "#dc2626", Operator: "#2563eb", "Read-Only": "#6b7280" };

  function renderUserBadge() {
    if (!currentUser) return;
    var header = document.querySelector(".page-header-actions");
    if (!header) {
      var ph = document.querySelector(".page-header");
      if (!ph) return;
      header = document.createElement("div");
      header.className = "page-header-actions";
      ph.appendChild(header);
    }
    var existing = header.querySelectorAll(".user-badge");
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var name = currentUser.displayName || currentUser.username || "";
    var role = currentUser.role || "";
    var label = ROLE_LABEL[role] || role;
    // A polaris .hue-pill takes only --hue: styles.css derives the fill and
    // clamps the label per theme, so a red pill stays legible on daylight.
    var pillColor = ROLE_COLOR[role] || "#6b7280";
    var badge = document.createElement("div");
    badge.className = "user-badge";
    badge.title = name + (label ? " (" + label + ")" : "");
    badge.innerHTML =
      '<div class="user-badge-avatar" style="background:' + initialsColor(name) + '">' + escapeHtml(getInitials(name)) + "</div>" +
      '<span class="user-badge-name">' + escapeHtml(name) + "</span>" +
      (label ? '<span class="badge hue-pill" style="font-size:0.7rem;padding:1px 6px;--hue:' + pillColor + '">' + escapeHtml(label) + "</span>" : "");
    header.appendChild(badge);
  }

  // ─── Permissions ─────────────────────────────────────────────────────────────
  function can(key, level) {
    if (!key) return true;
    var perms = currentUser && currentUser.permissions;
    return RANK[(perms && perms[key]) || "none"] >= RANK[level || "read"];
  }

  // ─── Nav ───────────────────────────────────────────────────────────────────
  var ICONS = {
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 01-12 0V8h12z"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  };

  // href, label, icon, [permKey, level]
  var NAV_ITEMS = [
    ["/index.html", "Dashboard", "grid", null],
    ["/endpoints.html", "Endpoints", "monitor", "endpoints"],
    ["/tags.html", "Tags & Policies", "layers", "tags"],
    ["/groups.html", "Groups", "box", "groups"],
    ["/integrations.html", "Integrations", "plug", "integrations"],
    ["/events.html", "Events", "activity", "events"],
  ];

  // ─── Branding (Server Settings → Customization) ──────────────────────────────
  // GET /server-settings/branding, cached in localStorage like polaris so the
  // sidebar paints the saved name/logo on first render without a flash.
  var BRAND_CACHE_KEY = "charon-branding";
  var branding = (function () {
    try { return JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || "null"); } catch (e) { return null; }
  })();
  function setBranding(b) {
    if (!b || typeof b !== "object") return;
    branding = b;
    try { localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(b)); } catch (e) { /* storage blocked */ }
    renderNav();
  }
  function brandHtml() {
    var b = branding || {};
    var name = typeof b.appName === "string" ? b.appName : "Charon";
    var sub = typeof b.subtitle === "string" ? b.subtitle : "Zero Trust Network Access";
    // Only our own fixed upload names (server: brandingService.hasCustomLogo).
    var logo = b.customLogo && b.logoOnSidebar !== false && /^\/uploads\/custom-logo\.(png|jpg|webp)$/.test(b.logoUrl || "")
      ? b.logoUrl + (b.logoVersion ? "?v=" + encodeURIComponent(b.logoVersion) : "")
      : "";
    return (logo ? '<img class="sidebar-logo" src="' + escapeHtml(logo) + '" alt="">' : "") +
      (name ? '<h1 style="font-size:1.15rem;font-weight:700;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;letter-spacing:1px;text-transform:uppercase">' + escapeHtml(name) + "</h1>" : "") +
      (sub ? '<p style="font-size:0.72rem;color:var(--color-text-tertiary);margin:0.15rem 0 0;text-align:center;letter-spacing:0.5px">' + escapeHtml(sub) + "</p>" : "");
  }

  function renderNav() {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    var current = window.location.pathname;
    if (current === "/") current = "/index.html";

    var items = NAV_ITEMS.filter(function (n) { return can(n[3], "read"); }).map(function (n) {
      var active = current === n[0] ? " active" : "";
      return '<li><a href="' + n[0] + '" class="' + active.trim() + '">' + ICONS[n[2]] + "<span>" + n[1] + "</span></a></li>";
    }).join("");

    // Any key that unlocks a Server Settings tab (SETTINGS_TAB_PERMS in
    // server-settings.js) earns the link — Credentials and API Tokens included.
    var showSettings = ["serverSettingsSystem", "serverSettingsData", "credentials", "apiTokens"]
      .some(function (k) { return can(k, "read"); });

    sidebar.innerHTML =
      '<div class="sidebar-brand">' + brandHtml() + "</div>" +
      '<ul class="sidebar-nav">' + items + "</ul>" +
      '<div style="margin-top:auto">' +
        (showSettings
          ? '<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)"><a href="/server-settings.html" class="sidebar-bottom-link' + (current === "/server-settings.html" ? " active" : "") + '">' + ICONS.settings + "<span>Server Settings</span></a></div>"
          : "") +
        // The theme band; the padding/border pair depends on whether the
        // Server Settings block above rendered (polaris renderNav).
        '<div style="padding:' + (showSettings ? "0.25rem" : "0.5rem") + " 0.5rem 0.25rem;" + (showSettings ? "" : "border-top:1px solid var(--color-border-light);") + '">' + themeBandHtml() + "</div>" +
        '<div style="padding:0.25rem 0.5rem 0.75rem"><a href="#" id="btn-logout" class="sidebar-bottom-link sidebar-bottom-link-logout">' + ICONS.logout + "<span>Logout</span></a></div>" +
        '<div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em"></div>' +
      "</div>";

    // Placed after the markup lands: its position is measured against the
    // rendered art, and every render hands it a brand-new, unseated track.
    seatThemeBands();
    var lo = document.getElementById("btn-logout");
    if (lo) lo.addEventListener("click", function (e) {
      e.preventDefault();
      fetch("/api/v1/auth/logout", { method: "POST", headers: csrfHeaders() }).finally(function () { location.href = "/login.html"; });
    });

    var v = document.getElementById("sidebar-version");
    if (v && currentUser && currentUser._version) v.textContent = "v" + currentUser._version;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────
  function init(opts) {
    opts = opts || {};
    return fetch("/api/v1/auth/me", { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("unauth"); return r.json(); })
      .then(function (user) {
        currentUser = user;
        renderNav();
        renderUserBadge();
        // Best-effort version stamp for the sidebar.
        fetch("/api/v1/server-settings/identification", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d && d.version) { currentUser._version = d.version; var v = document.getElementById("sidebar-version"); if (v) v.textContent = "v" + d.version; } })
          .catch(function () {});
        // Saved branding (name / subtitle / logo) — repaints only if it changed.
        fetch("/api/v1/server-settings/branding", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (b) { if (b && JSON.stringify(b) !== JSON.stringify(branding)) setBranding(b); })
          .catch(function () {});
        if (typeof opts.onUser === "function") opts.onUser(user);
        return user;
      })
      .catch(function () { if (location.pathname !== "/login.html") location.href = "/login.html"; });
  }

  window.Charon = {
    init: init,
    toast: toast,
    escapeHtml: escapeHtml,
    csrfHeaders: csrfHeaders,
    can: function (k, l) { return can(k, l); },
    user: function () { return currentUser; },
    setBranding: setBranding,
    isLightTheme: isLightTheme,
    advanceTheme: advanceTheme,
  };
  // Polaris's global names, for code ported from it.
  window.isLightTheme = isLightTheme;
  window.advanceTheme = advanceTheme;
})();
