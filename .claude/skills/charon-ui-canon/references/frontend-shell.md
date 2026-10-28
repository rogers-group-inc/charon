# Frontend shell

From ARCHITECTURE.md § 10 (verbatim first paragraph), expanded.

Vanilla, no build. `api.js` (CSRF-threaded fetch, 401→login), `app.js`
(`Charon.init()` → fetch `/auth/me` → render permission-gated sidebar → page
load; toast; theme), `table-sf.js` + `styles.css` (verbatim from polaris) +
`charon.css` (overlay). Pages: login, index (dashboard), endpoints, tags,
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
logo (`app.js → brandHtml()`).

## `window.Charon`

`init`, `toast`, `escapeHtml`, `csrfHeaders`, `can`, `user` — exported by `public/js/app.js`.
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
