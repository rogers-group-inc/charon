---
name: charon-ui-canon
description: "Charon frontend (vanilla JS, no build step, public/): the shared Polaris UI design system (public/css/styles.css is a verbatim copy) plus the additive charon.css overlay, which file is the reference implementation of each UI pattern (table + modal + toast, cards + data-driven modal, tabs, the Server Settings folder tabs + folder card with per-tab modules (settings-api.js / settings-ui.js), the TableSF sortable / filterable / adjustable-column table), the page → permission-gate table, the shared modules never to re-derive (api.js, app.js window.Charon, table-sf.js, theme-init.js), and the agent's web GUI reusing the stylesheet. Load for any change under public/ or agent/ui/, any HTML/CSS/JS/theme work, a new page, table, modal, tab, badge or toast, nav or sidebar gating, Charon.can(), or a question about how the UI is built."
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
| Server Settings | `public/server-settings.html` | nav: `serverSettingsSystem:read` or `serverSettingsData:read`; each tab gated separately (below) |
| Login | `public/login.html` | public |
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
| Authentication (`auth`) — Charon's own | `server-settings-auth.js` | `serverSettingsSystem` |
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
- **Script order** on an app page: `theme-init.js` (head) → `api.js` → `app.js` → `table-sf.js`
  when used → the page script.
- **The Server Settings page is a polaris port with its own client layer**: `settings-api.js`
  (polaris `api.<namespace>.*`) and `settings-ui.js` (polaris `openModal` / `showConfirm` /
  slide-overs / `permAtLeast`) are loaded ONLY by `public/server-settings.html`, where
  `settings-api.js` replaces Charon's `api.js` (not loaded there). Never use them on another
  page; a new tab module calls `settings-api.js`, not `window.api`.
- **Escape everything interpolated into HTML** with `Charon.escapeHtml`.
- **Gate controls with the key the route actually checks** — a client gate naming another
  page's key fails silently (the control never renders).
- **Menu entries never end in "…"** ("Edit", not "Edit…"), even when they open a dialog.
- `public/` scripts share one global scope and have no typecheck: after a merge that touched
  `public/js`, open the page and read the console.

Related: `charon-api-rbac` (the gates behind each page), `charon-agent` (`agent/ui/`).
