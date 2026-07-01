/**
 * public/js/app.js — Charon dashboard shell.
 *
 * Emits the SAME sidebar DOM structure polaris uses (`.sidebar-brand`,
 * `.sidebar-nav`, `.sidebar-bottom-link`, `.theme-toggle`) so the copied polaris
 * `styles.css` themes it identically. Charon nav + permission gating comes from
 * GET /auth/me. Also provides the shared toast, theme, escapeHtml, and
 * `Charon.{init,toast,escapeHtml,can}` used by every page.
 */
(function () {
  "use strict";

  var currentUser = null;
  var RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };

  // ─── Theme ─────────────────────────────────────────────────────────────────
  function getTheme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function setTheme(t) { document.documentElement.setAttribute("data-theme", t); localStorage.setItem("charon-theme", t); renderNav(); }
  var sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';

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

  function renderNav() {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    var current = window.location.pathname;
    if (current === "/") current = "/index.html";

    var items = NAV_ITEMS.filter(function (n) { return can(n[3], "read"); }).map(function (n) {
      var active = current === n[0] ? " active" : "";
      return '<li><a href="' + n[0] + '" class="' + active.trim() + '">' + ICONS[n[2]] + "<span>" + n[1] + "</span></a></li>";
    }).join("");

    var showSettings = can("serverSettingsSystem", "read") || can("serverSettingsData", "read");
    var userBadge = currentUser
      ? '<div class="sidebar-user"><span class="badge">' + escapeHtml(currentUser.role || "") + "</span>" +
        '<span class="sidebar-user-name">' + escapeHtml(currentUser.displayName || currentUser.username || "") + "</span></div>"
      : "";

    sidebar.innerHTML =
      '<div class="sidebar-brand">' +
        '<h1 style="font-size:1.15rem;font-weight:700;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;letter-spacing:1px;text-transform:uppercase">Charon</h1>' +
        '<p style="font-size:0.72rem;color:var(--color-text-tertiary);margin:0.15rem 0 0;text-align:center;letter-spacing:0.5px">Zero Trust Network Access</p>' +
      "</div>" +
      '<ul class="sidebar-nav">' + items + "</ul>" +
      '<div style="margin-top:auto">' +
        userBadge +
        (showSettings
          ? '<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)"><a href="/server-settings.html" class="sidebar-bottom-link' + (current === "/server-settings.html" ? " active" : "") + '">' + ICONS.settings + "<span>Server Settings</span></a></div>"
          : "") +
        '<div style="padding:0.25rem 0.5rem 0"><button id="btn-theme-toggle" class="theme-toggle">' + (getTheme() === "dark" ? sunIcon : moonIcon) + "<span>" + (getTheme() === "dark" ? "Light Mode" : "Dark Mode") + "</span></button></div>" +
        '<div style="padding:0.25rem 0.5rem 0.75rem"><a href="#" id="btn-logout" class="sidebar-bottom-link sidebar-bottom-link-logout">' + ICONS.logout + "<span>Logout</span></a></div>" +
        '<div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em"></div>' +
      "</div>";

    var tt = document.getElementById("btn-theme-toggle");
    if (tt) tt.addEventListener("click", function () { setTheme(getTheme() === "dark" ? "light" : "dark"); });
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
        // Best-effort version stamp for the sidebar.
        fetch("/api/v1/server-settings/identification", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d && d.version) { currentUser._version = d.version; var v = document.getElementById("sidebar-version"); if (v) v.textContent = "v" + d.version; } })
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
  };
})();
