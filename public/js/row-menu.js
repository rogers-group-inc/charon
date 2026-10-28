/**
 * public/js/row-menu.js — the polaris row context menu (showRowMenu /
 * closeRowMenu / rowMenuGesture), copied verbatim from polaris public/js/app.js
 * for the polaris-port pages that use it (users.js). The only change: the
 * whole-row right-click target (tr[data-row-menu-row]) selects nothing first —
 * Charon has no selectable tables yet — so _rowSelectForMenu is a no-op.
 */

function _rowSelectForMenu(_tr) { /* no selectable tables in Charon */ }

var _rowMenuTeardown = null;
var _rowMenuForced = null;

/**
 * Is the click being handled right now a request for the MENU (a right click
 * replayed by the contextmenu listener)? Returns the pointer position to open
 * it at ({ x, y }, or { x: null } for a keyboard Menu key), else null.
 */
function rowMenuGesture() {
  return _rowMenuForced;
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("contextmenu", function (e) {
    if (e.defaultPrevented || e.shiftKey) return; // Shift+right-click keeps the browser's own menu
    var t = e.target;
    var trigger = t && typeof t.closest === "function" ? t.closest(".row-menu-trigger, [data-row-menu]") : null;
    if (!trigger) {
      var row = t && typeof t.closest === "function" ? t.closest("tr[data-row-menu-row]") : null;
      if (!row || t.closest('input, textarea, select, [contenteditable], a[href]:not([href="#"])')) return;
      trigger = row.querySelector(".row-menu-trigger, [data-row-menu]");
      if (!trigger) return;
      t = trigger;
    }
    e.preventDefault();
    var menuRow = trigger.closest("tr[data-row-menu-row]");
    if (menuRow) _rowSelectForMenu(menuRow);
    // A keyboard-raised contextmenu reports (0, 0); anchor under the trigger then.
    var fromPointer = e.clientX || e.clientY;
    _rowMenuForced = fromPointer ? { x: e.clientX, y: e.clientY } : { x: null, y: null };
    try {
      t.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true, cancelable: true, view: window,
        clientX: e.clientX, clientY: e.clientY,
      }));
    } finally {
      _rowMenuForced = null;
    }
  });
}

/** Close whatever row menu is open. Safe to call when none is. */
function closeRowMenu(opts) {
  if (_rowMenuTeardown) _rowMenuTeardown(opts || {});
}

// `.row-context-menu`'s z-index in styles.css. Duplicated here because the
// lift below has to know when it would be a DEMOTION; keep the two in step.
var ROW_MENU_BASE_Z = 900;

// Stamped on the anchor for as long as its menu is open, and removed on every
// close path. The contract it publishes: "a position:fixed menu is pinned to
// this element — do not move it." Anything that scrolls or animates a
// container on its own initiative reads it and holds: the dashboard's NOC
// auto-scroll (dashboard.js → startAutoScroll) pauses the widget body that
// holds a stamped row, because one 1px creep tick fires the scroll handler
// below, which closes the menu the operator was still reaching for. The hover
// pause cannot cover that case — the menu is mounted on <body>, so moving the
// pointer onto it is a mouseleave from the widget.
var ROW_MENU_OPEN_ATTR = "data-rowmenu-open";

/**
 * The z-index a row menu needs to clear the layer its ANCHOR sits in: the
 * greatest z-index on the anchor's ancestors, plus one. Returns 0 when nothing
 * above the CSS base (900) is in play, so a plain list-page menu keeps the
 * stylesheet's value and stays under the modal overlay it usually opens.
 *
 * Reads computed style rather than a list of known overlay classes: the layers
 * a menu can be opened from already number half a dozen (modal 1000,
 * slide-over 1050, above-slideover modal 1075, monitor-confirm 1100,
 * sf-multi-popover 1200, address-book picker 1300 / its editor 1320) and a
 * hardcoded bump would be wrong for the next one either way.
 */
function _rowMenuLayer(anchor) {
  var max = 0;
  for (var el = anchor; el && el !== document.body; el = el.parentElement) {
    var z = parseInt(window.getComputedStyle(el).zIndex, 10);
    if (!isNaN(z) && z > max) max = z;
  }
  return max >= ROW_MENU_BASE_Z ? max + 1 : 0;
}

function showRowMenu(anchor, items, opts) {
  if (!anchor || !items || !items.length) return;
  var at = (opts && opts.menuAt) || _rowMenuForced;
  // A plain click runs the primary verb instead of showing the menu.
  if (!at) {
    var primary = items.find(function (it) { return it && it.primary && !it.disabled && typeof it.onSelect === "function"; });
    if (primary) {
      closeRowMenu({ silent: true });
      try { primary.onSelect(); } catch (err) { if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error"); }
      return;
    }
  }
  // A second click on the same anchor toggles rather than stacking menus — a
  // left click only; a second right click re-opens the menu at the new point.
  var reopening = !at && _rowMenuTeardown && _rowMenuTeardown.anchor === anchor;
  closeRowMenu({ silent: true });
  if (reopening) return;

  var menu = document.createElement("div");
  menu.className = "btn-dropdown-menu row-context-menu open";
  menu.setAttribute("role", "menu");
  if (opts && opts.label) menu.setAttribute("aria-label", opts.label);

  var buttons = [];
  items.forEach(function (it) {
    if (!it) return;
    if (it.separator) {
      var hr = document.createElement("div");
      hr.className = "dropdown-divider";
      menu.appendChild(hr);
      return;
    }
    if (it.heading) {
      var h = document.createElement("div");
      h.className = "dropdown-heading";
      h.textContent = it.heading;
      menu.appendChild(h);
      return;
    }
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    // `icon` is developer-supplied SVG markup (ICONS / _sunIcon), never user
    // data, so innerHTML is safe here; the label stays textContent regardless.
    if (it.icon) {
      b.innerHTML = it.icon;
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      b.appendChild(lbl);
      b.className = "has-icon" + (it.danger ? " danger" : "");
    } else {
      b.textContent = it.label;
      if (it.danger) b.className = "danger";
    }
    if (it.title) b.title = it.title;
    if (it.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", function () {
        // Close BEFORE the handler runs: most of these open a modal or a
        // slide-over, and a lingering fixed menu would float over it.
        closeRowMenu();
        try { it.onSelect(); } catch (err) { if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error"); }
      });
      buttons.push(b);
    }
    menu.appendChild(b);
  });
  if (!buttons.length && !menu.childNodes.length) return;

  // The menu is body-mounted and `position: fixed`, so its stacking is decided
  // against the other BODY-level layers — not against the surface the row is
  // on. At the CSS base (900) that is right for a list page (above the sticky
  // header, below the modal a verb opens) and wrong everywhere else: a menu
  // opened from INSIDE a slide-over (overlay 1050) or a modal (1000 / 1075)
  // rendered behind the very panel that owns the row, which is how the asset
  // details General tab's upstream rows shipped in 2026-09. Lift it to just
  // above its anchor's own layer.
  var layer = _rowMenuLayer(anchor);
  if (layer) menu.style.zIndex = String(layer);

  document.body.appendChild(menu);

  // Position under the anchor, flipped when it would leave the viewport.
  var r = anchor.getBoundingClientRect();
  var mw = menu.offsetWidth;
  var mh = menu.offsetHeight;
  var pad = 6;
  // Opened by a right click: at the pointer, as a context menu sits.
  if (at && at.x != null) r = { top: at.y, bottom: at.y, left: at.x, right: at.x };
  var top = r.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    var above = r.top - 4 - mh;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - mh);
  }
  // Left-aligned to the anchor by default; `align:"end"` right-aligns it, which
  // is what a trigger sitting at the right edge of the page header wants.
  var left = (opts && opts.align === "end") ? r.right - mw : r.left;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - mw);
  if (left < pad) left = pad;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  // ── Dismissal + keyboard ────────────────────────────────────────────────
  function onDocPointerDown(e) {
    // `contains` on the anchor, not identity: a trigger with child elements
    // (the account badge's avatar / name / caret) would otherwise close here
    // on pointerdown and immediately re-open on the click, so a second click
    // could never dismiss it.
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeRowMenu();
  }
  function onKeyDown(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeRowMenu(); return; }
    if (e.key === "Tab") { closeRowMenu(); return; }
    if (!buttons.length) return;
    var idx = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var next = e.key === "ArrowDown"
        ? (idx < 0 ? 0 : (idx + 1) % buttons.length)
        : (idx <= 0 ? buttons.length - 1 : idx - 1);
      buttons[next].focus();
    } else if (e.key === "Home") { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1].focus(); }
  }
  // Capture-phase scroll so a scroll inside the table wrapper closes it too —
  // the menu is fixed and cannot track its anchor. But only a scroll that
  // MOVED the anchor is a reason to close: the dashboard's NOC auto-scroll
  // creeps every overflowing widget body by a pixel every 80ms, and closing on
  // those made the account menu flash open and vanish on that page. A scroll in
  // a container that doesn't hold the anchor leaves the menu correctly placed.
  function onScroll(e) {
    var t = e && e.target;
    // Document-level scroll (target is the Document node) moves everything.
    if (!t || t.nodeType === 9 || typeof t.contains !== "function") { closeRowMenu(); return; }
    if (t.contains(anchor)) closeRowMenu();
  }
  function onScrollOrResize() { closeRowMenu(); }

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScrollOrResize);

  _rowMenuTeardown = function (o) {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScrollOrResize);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    _rowMenuTeardown = null;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      anchor.removeAttribute(ROW_MENU_OPEN_ATTR);
    }
    // Hand focus back so keyboard users don't land at the top of the document —
    // except when another affordance is about to claim it (silent close).
    if (!(o && o.silent) && typeof anchor.focus === "function") {
      try { anchor.focus(); } catch (_) { /* row re-rendered */ }
    }
  };
  _rowMenuTeardown.anchor = anchor;

  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute(ROW_MENU_OPEN_ATTR, "");
  // A right click focuses the MENU, not its first item: Chrome draws a focus
  // ring on a programmatically focused item whenever the last input was a key
  // — and Ctrl+click to build a selection is one — so the first item came up
  // boxed. The capture-phase arrow handler above still works from here, and
  // the first ↓ lands on the first item. A keyboard-raised menu (Menu key,
  // Shift+F10: at.x null) and a plain click's menu keep the item focus.
  if (at && at.x != null) {
    menu.tabIndex = -1;
    try { menu.focus({ preventScroll: true }); } catch (_) { menu.focus(); }
  } else if (buttons.length) {
    buttons[0].focus();
  }
}

if (typeof window !== "undefined") {
  window.showRowMenu = showRowMenu;
  window.closeRowMenu = closeRowMenu;
  window.rowMenuGesture = rowMenuGesture;
}
