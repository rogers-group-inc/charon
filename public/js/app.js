/**
 * public/js/app.js — Shared dashboard shell: sidebar nav, current-user load,
 * permission-gated navigation, theme toggle, and a minimal toast.
 *
 * Lifecycle every page follows: DOMContentLoaded → Charon.init() →
 * fetchCurrentUser() → render nav (gated by permissions) → page-specific load.
 */
(function () {
  "use strict";

  // [page-path, label, function-key required to see it] — null key = always shown.
  var NAV = [
    ["/index.html", "Dashboard", null],
    ["/endpoints.html", "Endpoints", "endpoints"],
    ["/tags.html", "Tags & Policies", "tags"],
    ["/groups.html", "Groups", "groups"],
    ["/integrations.html", "Integrations", "integrations"],
    ["/users.html", "Users", "users"],
    ["/server-settings.html", "Server Settings", "serverSettingsSystem"],
    ["/events.html", "Events", "events"],
  ];

  var RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  var currentUser = null;

  function can(perms, key, level) {
    if (!key) return true;
    return RANK[(perms && perms[key]) || "none"] >= RANK[level || "read"];
  }

  function renderSidebar(user) {
    var perms = user.permissions || {};
    var here = location.pathname === "/" ? "/index.html" : location.pathname;
    var items = NAV.filter(function (n) { return can(perms, n[2], "read"); })
      .map(function (n) {
        var active = n[0] === here ? ' class="active"' : "";
        return '<a href="' + n[0] + '"' + active + ">" + n[1] + "</a>";
      }).join("");

    var el = document.getElementById("sidebar");
    if (!el) return;
    el.innerHTML =
      '<div class="sidebar-brand">Charon</div>' +
      '<nav class="sidebar-nav">' + items + "</nav>" +
      '<div class="sidebar-footer">' +
        '<div class="sidebar-user">' +
          '<span class="badge" style="background:' + "var(--accent)" + '">' + escapeHtml(user.role || "") + "</span>" +
          "<span>" + escapeHtml(user.displayName || user.username || "") + "</span>" +
        "</div>" +
        '<button id="themeToggle" class="btn btn-ghost btn-sm" type="button">Theme</button> ' +
        '<button id="logoutBtn" class="btn btn-ghost btn-sm" type="button">Log out</button>' +
        '<div class="sidebar-version" id="appVersion"></div>' +
      "</div>";

    var lo = document.getElementById("logoutBtn");
    if (lo) lo.addEventListener("click", function () {
      window.api.logout().finally(function () { location.href = "/login.html"; });
    });
    var th = document.getElementById("themeToggle");
    if (th) th.addEventListener("click", toggleTheme);
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", cur);
    localStorage.setItem("charon-theme", cur);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, kind) {
    var t = document.createElement("div");
    t.className = "toast toast-" + (kind || "info");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 300); }, 3500);
  }

  function init(opts) {
    opts = opts || {};
    return window.api.me().then(function (user) {
      currentUser = user;
      renderSidebar(user);
      if (typeof opts.onUser === "function") opts.onUser(user);
      return user;
    }).catch(function () {
      if (location.pathname !== "/login.html") location.href = "/login.html";
    });
  }

  window.Charon = {
    init: init,
    toast: toast,
    escapeHtml: escapeHtml,
    can: function (key, level) { return can(currentUser && currentUser.permissions, key, level); },
    user: function () { return currentUser; },
  };
})();
