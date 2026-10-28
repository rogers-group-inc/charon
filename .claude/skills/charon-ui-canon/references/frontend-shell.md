# Frontend shell

From ARCHITECTURE.md § 10 (verbatim first paragraph), expanded.

Vanilla, no build. `api.js` (CSRF-threaded fetch, 401→login), `app.js`
(`Charon.init()` → fetch `/auth/me` → render permission-gated sidebar → page
load; toast; theme), `table-sf.js` + `styles.css` (verbatim from polaris) +
`charon.css` (overlay), `theme-init.js` (polaris theme system, below). Pages: login, index (dashboard), endpoints, tags,
groups, integrations, server-settings (tabbed), events, setup.

## Nav and permission gating

`public/js/app.js → NAV_ITEMS` is `[href, label, icon, permKey]`; `renderNav()` keeps an item
when `can(permKey, "read")`, and shows Server Settings when either `serverSettingsSystem` or
`serverSettingsData` is readable. `can(key, level)` ranks the current user's
`permissions[key]` (from `/auth/me`) against the level, defaulting to `read`. A new page needs a
`NAV_ITEMS` row with the key its mount checks (`charon-api-rbac` → routes-overview.md).

The sidebar brand (name, subtitle, optional logo) comes from `GET /server-settings/branding`
(Server Settings → Customization), cached in localStorage (`charon-branding`) so it paints
without a flash; only Charon's fixed `/uploads/custom-logo.(png|jpg|webp)` URLs render as a
logo (`app.js → brandHtml()`). The login page (`login.js`) reads the public trimmed view at
`GET /branding` before sign-in: name, subtitle, and the logo only when "show on login page" is on.

## Theme system (polaris's, ported whole)

Three selectable themes — `morning`, `noon` (daylight family) and `nightfall` (dark, the
default) — plus `afternoon`, a transit palette the dial fades through but never saves. The
retired `dark` / `light` ids match nothing and fall back to the OS preference.

| Piece | Where |
|---|---|
| Token blocks, crossfade, page glows, `.theme-band` styles, view-transition types (`polaris-theme*` — keep the name, the CSS keys on it) | `public/css/styles.css` (verbatim polaris) |
| Pre-paint resolve (`charon-theme` in localStorage → else OS: light → `morning`, otherwise `nightfall`), and following the OS while nothing is saved | `public/js/theme-init.js` (`KNOWN`) |
| The dial: `THEMES`, `TRANSIT_THEMES`, `THEME_BAND_POS`, `advanceTheme()`, the sidebar band markup, the `themechange` event | `public/js/app.js` |
| Band art | `public/img/brand/time-strip-desktop.webp` (from polaris) |

The band sits in the sidebar between Server Settings and Logout; one click steps to the next
theme (delegated listener — never wire a second one). Branch on `Charon.isLightTheme()` (also
`window.isLightTheme`), never on an id; anything that caches colours listens for
`themechange`. Adding a theme = add it in polaris first, re-copy `styles.css`, then one entry in
`THEMES` + `THEME_BAND_POS` + `KNOWN`. `tests/unit/themeSystem.test.ts` fails when the three
lists disagree. Not ported: polaris's `page-transitions.css` (cross-page crossfade) and
`brand-logo.js` (theme-paired Polaris logo art, which Charon does not use).

## `window.Charon`

`init`, `toast`, `escapeHtml`, `csrfHeaders`, `can`, `user`, `setBranding`, `isLightTheme`,
`advanceTheme` — exported by `public/js/app.js`.
Page scripts call `Charon.init()` first and build after it resolves; an unauthenticated
`/auth/me` redirects to `/login.html`.

## Setup wizard

`public/setup.html` + `public/js/setup.js` talk to the unauthenticated first-run API
(`src/setup/setupRoutes.ts`, served by `src/setup/setupServer.ts`) and load no `app.js`. After
finalize the server process exits; the page polls `/health` until the configured app answers,
then redirects to login (`charon-deploy` → cross-cutting-deployment.md → First-run wizard).

## The agent GUI

`agent/ui/` (vanilla JS, `index.html` + `app.js`) reuses the Charon stylesheet so the agent
matches the server: an enrollment view → the server-dictated login view. See `charon-agent`.
