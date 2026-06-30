/**
 * public/js/api.js — Charon frontend API client (vanilla, no build step).
 *
 * Core plumbing reused by every page: a fetch wrapper that threads the CSRF
 * token on state-changing requests, JSON parsing, uniform error handling, and a
 * 401 → /login.html redirect. Resource-specific helpers are thin wrappers over
 * api.get/post/put/del added per page.
 */
(function () {
  "use strict";

  var API_BASE = "/api/v1";

  function _readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function _csrfHeaders(extra) {
    var headers = extra || {};
    var csrf = _readCookie("charon_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
    return headers;
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    var init = { method: method, headers: {}, credentials: "same-origin" };
    if (method !== "GET" && method !== "HEAD") {
      var csrf = _readCookie("charon_csrf");
      if (csrf) init.headers["X-CSRF-Token"] = csrf;
    }
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      init.body = body;
    }
    return fetch(API_BASE + path, init).then(function (res) {
      if (res.status === 401 && !opts.noRedirect) {
        if (typeof window.__charonOn401 === "function") return window.__charonOn401();
        if (location.pathname !== "/login.html") location.href = "/login.html";
        return Promise.reject(new Error("Not authenticated"));
      }
      var ct = res.headers.get("content-type") || "";
      var parse = ct.indexOf("application/json") >= 0 ? res.json() : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var msg = data && data.error ? data.error : "Request failed (" + res.status + ")";
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  window.api = {
    base: API_BASE,
    csrfHeaders: _csrfHeaders,
    get: function (p, opts) { return request("GET", p, null, opts); },
    post: function (p, body, opts) { return request("POST", p, body, opts); },
    put: function (p, body, opts) { return request("PUT", p, body, opts); },
    del: function (p, body, opts) { return request("DELETE", p, body, opts); },
    me: function () { return request("GET", "/auth/me", null, { noRedirect: true }); },
    logout: function () { return request("POST", "/auth/logout"); },
  };
})();
