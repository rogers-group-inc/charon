// Runs before CSS loads to apply the user's saved theme and avoid a flash of
// wrong theme on pages like login and setup. Kept as a standalone file so we
// can drop 'unsafe-inline' from the script CSP.
//
// The theme system is polaris's (styles.css is a verbatim copy; the dial lives
// in app.js). With nothing saved — a fresh browser, and always the case on the
// login page of a first visit — follow the OS: "morning" for a light
// preference, and "nightfall" for dark or for a browser that expresses no
// preference. Nothing is written to localStorage here: an unsaved preference is
// what keeps a user tracking their system, and the in-app theme band is what
// opts them out. A retired theme id (the old "dark"/"light") fails the KNOWN
// check and falls back the same way as no preference at all.
(function () {
  // The selectable themes only. "afternoon" is deliberately absent: it is a
  // transit palette the dial fades through, never a saved preference, so a
  // reload mid-turn lands on a real theme instead of a waypoint.
  // MIRRORS app.js → THEMES (tests/unit/themeSystem.test.ts).
  var KNOWN = ["morning", "noon", "nightfall"];
  function saved() {
    var s = null;
    try { s = localStorage.getItem("charon-theme"); } catch (e) {}
    return s && KNOWN.indexOf(s) !== -1 ? s : null;
  }
  function osLight() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches); } catch (e) { return false; }
  }
  document.documentElement.setAttribute("data-theme", saved() || (osLight() ? "morning" : "nightfall"));

  // Keep following the OS while nothing is saved (polaris does this in
  // brand-logo.js, which Charon does not load). Deliberately does NOT write
  // localStorage; the first use of the band opts the user out for good.
  var mq;
  try { mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)"); } catch (e) { return; }
  if (!mq) return;
  var follow = function () {
    if (saved()) return;
    document.documentElement.setAttribute("data-theme", mq.matches ? "morning" : "nightfall");
  };
  if (mq.addEventListener) mq.addEventListener("change", follow);
  else if (mq.addListener) mq.addListener(follow);
})();
