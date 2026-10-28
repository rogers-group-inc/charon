// public/js/brand-logo.js — which mark to paint, and in which theme.
//
// Ported from polaris public/js/brand-logo.js. Two rules, one place, because
// they have to agree on the login card, the sidebar and the favicon:
//
//   1. Shipped art is THEME-AWARE: a light-inked mark on nightfall, a dark-
//      inked one on morning / noon, chosen by theme FAMILY (not id). Charon
//      ships NO art yet — ART below is null and every surface falls back to the
//      application name as text. Dropping the files into public/img/brand/ and
//      filling ART switches the art on everywhere at once (tests/unit/
//      brandLogo.test.ts checks every file ART names exists).
//   2. An operator's own logo (Server Settings → Customization) REPLACES it,
//      per surface (the "show on login page" / "show in sidebar" flags). The
//      application name shows next to a custom logo and as the text fallback,
//      never under shipped art, which spells the name out already.
//
// Following the OS while nothing is saved is theme-init.js's job (polaris did
// it here); this file only reacts to data-theme moving.

(function (global) {
  "use strict";

  // Where the shipped art lives, derived from THIS FILE's own URL (…/js/ → …/),
  // so the assets resolve if Charon is ever served from a subdirectory.
  var BASE = (function () {
    try {
      var el = document.currentScript || document.querySelector('script[src*="brand-logo.js"]');
      var src = el && el.getAttribute("src");
      if (src) return src.replace(/js\/brand-logo\.js.*$/, "");
    } catch (e) { /* fall through to the site root */ }
    return "/";
  })();

  // null until Charon has its own art. The shape, when it does (paths relative
  // to public/, as polaris's):
  //   login:   { dark: "img/brand/charon-horiz-dark.png",  light: "img/brand/charon-horiz-light.png" },
  //   sidebar: { dark: "img/brand/charon-vert-dark.png",   light: "img/brand/charon-vert-light.png" },
  //   favicon: { dark: "img/brand/charon-symbol-dark.png", light: "img/brand/charon-symbol-light.png" },
  // "dark" is the art FOR the dark family (light ink), as in polaris.
  var ART = null;

  // The daylight themes. Duplicated from app.js's THEMES because this file
  // also runs on login.html, which never loads app.js; where app.js is present
  // its isLightTheme is the authority.
  var LIGHT_THEMES = ["morning", "noon"];

  /** The current theme's FAMILY: "light" | "dark". */
  function currentTheme() {
    if (typeof global.isLightTheme === "function") return global.isLightTheme() ? "light" : "dark";
    var id = document.documentElement.getAttribute("data-theme");
    return LIGHT_THEMES.indexOf(id) === -1 ? "dark" : "light";
  }

  /**
   * Does this branding payload carry a custom logo? `customLogo` comes with the
   * authenticated payload; the pre-login one (GET /branding) sends a logoUrl
   * only when there is a custom logo to show on the login page.
   */
  function isCustom(b) {
    if (!b) return false;
    if (typeof b.customLogo === "boolean") return b.customLogo && Boolean(b.logoUrl);
    return Boolean(b.logoUrl);
  }

  /** Is the custom logo wanted on this surface? The flags default ON. */
  function customOn(b, surface) {
    if (!isCustom(b)) return false;
    if (surface === "login")   return b.logoOnLogin   !== false;
    if (surface === "sidebar") return b.logoOnSidebar !== false;
    return true;
  }

  function artFor(surface) {
    var set = ART && ART[surface];
    return set ? BASE + set[currentTheme()] : null;
  }

  /**
   * Everything a surface needs to render its brand block:
   *   { src, custom, showName, showSubtitle }
   * `src` is null when there is nothing to paint (no custom logo, no art) —
   * the surface then shows the name as text.
   */
  function resolve(b, surface) {
    var name = Boolean(b && (b.appName || "").trim());
    var subtitle = Boolean(b && (b.subtitle || "").trim());
    if (customOn(b, surface)) {
      var v = b.logoVersion ? "v=" + encodeURIComponent(b.logoVersion) : "";
      return {
        src: b.logoUrl + (v ? (b.logoUrl.indexOf("?") === -1 ? "?" : "&") + v : ""),
        custom: true, showName: name, showSubtitle: subtitle,
      };
    }
    var art = artFor(surface);
    if (art) {
      // The running version as ?v=, so a page change paints it from cache.
      return {
        src: art + (b && b.version ? "?v=" + encodeURIComponent(b.version) : ""),
        custom: false, showName: false, showSubtitle: subtitle,
      };
    }
    return { src: null, custom: false, showName: true, showSubtitle: subtitle };
  }

  /**
   * Point an <img> at the right mark (or hide it) and tag it so CSS can size
   * shipped art (.brand-mark-*, styles.css) apart from an upload of any shape.
   */
  function applyTo(img, b, surface) {
    var r = resolve(b, surface);
    if (img) {
      if (r.src) { if (img.getAttribute("src") !== r.src) img.src = r.src; img.hidden = false; }
      else { img.removeAttribute("src"); img.hidden = true; }
      img.classList.toggle("brand-mark", Boolean(r.src) && !r.custom);
      img.classList.toggle("brand-mark-" + surface, Boolean(r.src) && !r.custom);
      img.alt = r.custom ? ((b && b.appName) || "") : (r.src ? "Charon" : "");
    }
    return r;
  }

  /**
   * Re-run `cb` when the theme FAMILY changes — the band, or theme-init.js
   * following the OS. morning → noon is one family: no repaint.
   */
  function onThemeChange(cb) {
    var last = currentTheme();
    var fire = function () {
      var now = currentTheme();
      if (now === last) return;
      last = now;
      cb(now);
    };
    document.addEventListener("themechange", fire);
    try {
      new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* no MutationObserver — the event path still covers the band */ }
  }

  /**
   * Point the page's favicon at `url`. Updates EVERY icon link and drops any
   * `media` attribute (one image serves both schemes); creates a link when the
   * page has none. No-op without a URL — never clear a working icon.
   */
  function setFavicon(url) {
    if (!url) return;
    var links = document.querySelectorAll('link[rel="icon"]');
    if (!links.length) {
      var l = document.createElement("link");
      l.rel = "icon";
      document.head.appendChild(l);
      links = [l];
    }
    for (var i = 0; i < links.length; i++) {
      links[i].removeAttribute("media");
      links[i].href = url;
    }
  }

  /**
   * The shipped favicon pair, when there is art: browser chrome follows the
   * OS rather than data-theme, so it is two links split by media query, as
   * polaris's pages declare them. Skipped when the page already has icons.
   */
  function installShippedFavicon() {
    if (!ART || !ART.favicon || document.querySelector('link[rel="icon"]')) return;
    var light = document.createElement("link");
    light.rel = "icon"; light.type = "image/png"; light.href = BASE + ART.favicon.light;
    var dark = document.createElement("link");
    dark.rel = "icon"; dark.type = "image/png"; dark.href = BASE + ART.favicon.dark;
    dark.media = "(prefers-color-scheme: dark)";
    document.head.appendChild(light);
    document.head.appendChild(dark);
  }
  installShippedFavicon();

  global.CharonBrandLogo = {
    ART: ART,
    currentTheme: currentTheme,
    isCustom: isCustom,
    customOn: customOn,
    resolve: resolve,
    applyTo: applyTo,
    onThemeChange: onThemeChange,
    setFavicon: setFavicon,
  };
})(window);
