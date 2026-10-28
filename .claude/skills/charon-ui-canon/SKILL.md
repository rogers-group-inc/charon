---
name: charon-ui-canon
description: "Charon frontend (vanilla JS, no build step, public/): the shared Polaris UI design system (public/css/styles.css is a verbatim copy) plus the additive charon.css overlay, which file is the reference implementation of each UI pattern (table + modal + toast, cards + data-driven modal, tabs, the Server Settings folder tabs + folder card with per-tab modules (settings-api.js / settings-ui.js), the TableSF sortable / filterable / adjustable-column table), the page → permission-gate table, the shared modules never to re-derive (api.js, app.js window.Charon, table-sf.js, theme-init.js), and the agent's web GUI reusing the stylesheet. Load for any change under public/ or agent/ui/, any HTML/CSS/JS/theme work (dark / light mode, the morning / noon / nightfall theme band, the page-change crossfade, the sidebar or login logo, favicon, brand-logo.js), a new page, table, modal, tab, badge or toast, the Users page / Authentication modal / My Account / login and signed-out pages, nav or sidebar gating, Charon.can(), or a question about how the UI is built."
---

# Charon UI canon

Charon's UI is vanilla JavaScript + static HTML in `public/`, served as-is (no build step). It
uses the **Polaris UI design system**: `public/css/styles.css` is a verbatim copy of Polaris's
stylesheet, so every class (`.layout`, `.page-header`, `.table-wrapper`, `.modal-overlay`,
`.btn*`, `.card`, `.settings-card`, `.page-tabs`, `.badge-*`) behaves as in Polaris.
`public/css/charon.css` is a small additive overlay — **never redefine a Polaris class there**.

**Design system.** Before building a new pattern, check whether Polaris UI already has it (the
Polaris repo's `design/` sources and its published Polaris UI design-system artifact). Reuse its
markup and class names; add only what is genuinely Charon-specific to `charon.css`. Charon has
no design system or design-sync of its own; if `styles.css` is re-copied from Polaris, diff it
first — a local edit there is lost on the next copy.

## Which file

| You are building or changing… | Read |
|---|---|
| a table, modal, toast, card grid, tabs, or the TableSF sortable / filterable table | [references/canon-patterns.md](references/canon-patterns.md) |
| the shell: `Charon.init()`, nav + permission gating, `api.js`, theme, page list | [references/frontend-shell.md](references/frontend-shell.md) |

Every pattern section names the canonical file and the conventions to match. If your change
replaces a canonical, moves its file, or invalidates a convention, fix the canon file in the same
commit (`/charon-docs-sync`).

## Page → gate

| Page | File | Gate (`Charon.can`) |
|---|---|---|
| Dashboard | `public/index.html` | — |
| Endpoints | `public/endpoints.html` | `endpoints:read` |
| Tags & Policies | `public/tags.html` | `tags:read` |
| Groups | `public/groups.html` | `groups:read` |
| Integrations | `public/integrations.html` | `integrations:read` |
| Events | `public/events.html` | `events:read` |
| Users | `public/users.html` + `public/js/users.js` (polaris port) | nav: `users:read` OR `authentication:read`; Roles section `roles:read`; Group Mappings `users:fullwrite`; Authentication button `authentication:read` (Save / Test at write) |
| My Account | `public/account.html` + `public/js/account.js` (user badge link) | — (any signed-in operator; own password / 2FA / passkeys) |
| Signed out | `public/signed-out.html` | public — every logout lands here (no form) |
| Server Settings | `public/server-settings.html` | nav: `serverSettingsSystem:read` or `serverSettingsData:read`; each tab gated separately (below) |
| Login | `public/login.html` + `public/js/login.js` | public — password, passkey, SSO buttons (shown per `/auth/*/config` probe), second-factor and forced-change steps; `?local=1` / `?error` bypass "skip login page" |
| First-run setup | `public/setup.html` | public, only before setup completes |

### Server Settings tab → gate (`public/js/server-settings.js → SETTINGS_TAB_PERMS`, read level)

| Tab (data-tab) | Module | Gate |
|---|---|---|
| Identification (`identification`) | `server-settings-identification.js` | `serverSettingsSystem` |
| Credentials (`credentials`) | `server-settings-credentials.js` | `credentials` |
| Repository (`firmware`) | `server-settings-firmware.js` | `serverSettingsSystem` |
| Customization (`customization`) | `server-settings-customization.js` | `serverSettingsSystem` |
| Time & NTP (`ntp`) | `server-settings-ntp.js` | `serverSettingsSystem` |
| Web Server (`certificates`) | `server-settings-webserver.js` (+ `pinned-tls-certs.js`) | `serverSettingsSystem` |
| Maintenance (`maintenance`) | `server-settings-maintenance.js` | `serverSettingsData` |
| Retention (`retention`) | `server-settings-maintenance.js` | `serverSettingsData` |
| API Tokens (`api-tokens`) | `server-settings-api-tokens.js` | `apiTokens` |
| High Availability (`ha`) | `server-settings-ha.js` | `serverSettingsSystem` |

The tab hide is UX only — every route checks its own key (`charon-api-rbac` → endpoints.md),
and a tab's mutating controls need the route's write / fullwrite level. Known gap: a user with
only `credentials` or `apiTokens` read gets no sidebar link (the nav checks the two
`serverSettings*` keys).

## Frontend conventions (always apply)

- **Shared modules, never re-derived**: `public/js/api.js` (`window.api.{get,post,put,patch,del}`,
  CSRF-threaded, 401 → login), `public/js/app.js` (`window.Charon.{init,toast,escapeHtml,
  csrfHeaders,can,user}`), `public/js/table-sf.js` (`TableSF`, `setupColumnLayout`),
  `public/js/theme-init.js` (loaded first in `<head>`).
- **Themes are polaris's** (`morning` / `noon` / `nightfall`, stepped by the sidebar band —
  frontend-shell.md → Theme system). Branch on `Charon.isLightTheme()`, never on a theme id;
  `dark` / `light` are retired.
- **Script order** on an app page: `theme-init.js` (head) → `api.js` → `brand-logo.js` →
  `app.js` → the `#polaris-nav-ready` marker → `table-sf.js` when used → the page script. The
  head also carries the render-blocking `#polaris-nav-ready` expect link and
  `page-transitions.css` (frontend-shell.md → Page-change crossfade).
- **The polaris-port pages have their own client layer**: `settings-api.js` (polaris
  `api.<namespace>.*`) and `settings-ui.js` (polaris `openModal` / `showConfirm` / slide-overs /
  `permAtLeast` / `val` / `revealOverlay` / `PolarisPrefs`) are loaded ONLY by
  `public/server-settings.html`, `public/users.html` and `public/account.html`, where
  `settings-api.js` replaces Charon's `api.js` (not loaded there). Never mix the two layers on
  one page; code on a port page calls `settings-api.js`, not `window.api`. The polaris
  row-context menu is `public/js/row-menu.js` (`showRowMenu`); the self-service modals are
  `password-self.js`, `totp-self.js`, `passkeys-self.js` (+ `webauthn.js`, which `login.js` also
  loads standalone).
- **Escape everything interpolated into HTML** with `Charon.escapeHtml`.
- **Gate controls with the key the route actually checks** — a client gate naming another
  page's key fails silently (the control never renders).
- **Menu entries never end in "…"** ("Edit", not "Edit…"), even when they open a dialog.
- `public/` scripts share one global scope and have no typecheck: after a merge that touched
  `public/js`, open the page and read the console.

Related: `charon-api-rbac` (the gates behind each page), `charon-agent` (`agent/ui/`).
