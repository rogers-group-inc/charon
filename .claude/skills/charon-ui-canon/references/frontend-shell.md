# Frontend shell

From ARCHITECTURE.md § 10 (verbatim first paragraph), expanded.

Vanilla, no build. `api.js` (CSRF-threaded fetch, 401→login), `app.js`
(`Charon.init()` → fetch `/auth/me` → render permission-gated sidebar → page
load; toast; theme), `table-sf.js` + `styles.css` (verbatim from polaris) +
`charon.css` (overlay), `theme-init.js` (polaris theme system, below). Pages: login, index (dashboard), endpoints, tags,
groups, integrations, server-settings (tabbed), events, users, account, signed-out, setup.

## Nav and permission gating

`public/js/app.js → NAV_ITEMS` is `[href, label, icon, permKey]`; `renderNav()` keeps an item
when `can(permKey, "read")` — `permKey` may be an array, any one of which suffices (Users:
`["users", "authentication"]`) — and shows Server Settings when either `serverSettingsSystem` or
`serverSettingsData` is readable. The user badge links to `/account.html`. `Charon.logout()`
signs out (SAML sessions via `/auth/saml/logout`, following the IdP's single-logout URL) and
lands on `/signed-out.html`; a client idle timer mirrors `autoLogoutMinutes` from `/auth/me`. `can(key, level)` ranks the current user's
`permissions[key]` (from `/auth/me`) against the level, defaulting to `read`. A new page needs a
`NAV_ITEMS` row with the key its mount checks (`charon-api-rbac` → routes-overview.md).

The sidebar brand (name, subtitle, optional logo) comes from `GET /server-settings/branding`
(Server Settings → Customization), cached in localStorage (`charon-branding`) so it paints
without a flash; only Charon's fixed `/uploads/custom-logo.(png|jpg|webp)` URLs render as a
logo (`app.js → brandHtml()`). The login page (`login.js`) reads the public trimmed view at
`GET /branding` before sign-in: name, subtitle, and the logo only when "show on login page" is on.

Which mark a surface paints is `public/js/brand-logo.js`'s call (`window.CharonBrandLogo`,
ported from polaris; loaded before `app.js` / `login.js`): a custom upload (per-surface flag)
→ shipped theme-paired art → none, in which case the name shows as text. Charon ships **no art
yet** — `ART` is null. To add it, drop light/dark files into `public/img/brand/` and fill `ART`
(login = horizontal, sidebar = vertical, favicon = symbol; the shape is in the file's
comment); the sidebar, login and favicon pick it up, swapping on a theme-family flip
(`onThemeChange` swaps the `<img>` only — never `renderNav`, which would snap the band).
An uploaded logo also becomes the favicon. `tests/unit/brandLogo.test.ts` covers the resolver
and fails if `ART` names a missing file.

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
lists disagree. Login and setup paint no wrapper fill, so the theme's sky glow shows behind
the card as on the app pages.

## Page-change crossfade (polaris's, ported whole)

`public/css/page-transitions.css` (verbatim polaris) opts the app pages into a cross-document
view transition with the sidebar held still. It needs, on every page that loads `app.js`:
`theme-init.js` in `<head>`; `<link rel="expect" href="#polaris-nav-ready" blocking="render">`
in `<head>`; the stylesheet link; and `<span id="polaris-nav-ready" hidden></span>`
immediately after the `app.js` script tag. The marker id keeps polaris's name so the copied
CSS's comments stay true. `app.js` draws the rail before first paint from the cached user
(`charon-user` in localStorage: name, role, permissions, version — UX only, cleared on logout
and on a failed `/auth/me`) via `renderNavFromCache()` at the end of the file. Login and setup
must never link `page-transitions.css` (logging in would crossfade).
`tests/unit/pageTransitionWiring.test.ts` checks every app page — a new page needs all four.

## `window.Charon`

`init`, `toast`, `escapeHtml`, `csrfHeaders`, `can`, `user`, `logout`, `setBranding`, `isLightTheme`,
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
`agent/ui/css/styles.css`, `agent/ui/css/charon.css` and `agent/ui/js/theme-init.js` are
byte-for-byte copies of the `public/` files (`tests/unit/agentUiSync.test.ts`); the agent's
own layout is `agent/ui/css/agent.css`. The agent has no theme band — it follows the OS
(morning / nightfall). After re-copying `styles.css` from polaris, copy it on into
`agent/ui/css/` too and bump `agent/VERSION`. Use `type="text"` (with `inputmode`) rather than
`type="url"` / `type="email"`: the polaris stylesheet styles only text, password, number and
datetime-local inputs.
