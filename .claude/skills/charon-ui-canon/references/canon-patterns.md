# UI canon — tables, modals, toasts, tabs, TableSF

Moved verbatim from TEMPLATES.md (its frontend entries).

### Table / modal / toast (frontend)
**Ref:** `public/js/integrations.js` (ported from polaris: integration-card list +
the script-built `openIntegrationModal` shell with one form builder per type, folder-card
page, read-only API consoles, live discovery pill) and
`public/js/endpoints.js` (table + modal). Use `window.api.{get,post,put,patch,del}`,
`window.Charon.{init,toast,escapeHtml,can}`. Tabs: the folder-tabs section below.
Polaris design system: `.layout` shell, `.page-header > h2`, `.table-wrapper >
table` + `.empty-state`, `.modal-overlay/.modal` (toggle `.open`), `.btn`/
`.btn-secondary`/`.btn-icon`/`.btn-sm`, `.card`/`.card-title`, `.settings-card`,
`.page-tabs`, polaris `.badge-*` variants — all from the copied `styles.css`.
`charon.css` is only a small additive overlay; never redefine a polaris class.

### Sortable / filterable / adjustable-column table (TableSF)
**Ref:** `public/js/events.js` + `public/js/table-sf.js`. The canonical rich
table. Mark each `<th>` with `data-sf-key` + `data-sf-type` (string|number|
date|ip|array); add `data-sf-options="a|b|c"` for a multi-select filter and
`data-col-default-hidden="true"` to start a column hidden. Then:
`var sf = new TableSF("tbody-id", render)` gives per-column inline filter + click
sort — `render()` calls `sf.apply(rawRows)` and rebuilds the tbody (cells in the
SAME order as the headers). `setupColumnLayout(tableEl, {chooserButton, onChange})`
adds resizable widths + a show/hide column chooser; persist its `getPrefs()` /
`setPrefs()` in localStorage. Load `table-sf.js` before the page script.

### Folder tabs + folder card, per-tab modules (Server Settings)
**Ref:** `public/server-settings.html` + `public/js/server-settings.js` + `public/js/folder-tabs.js`,
ported from polaris. The `.page-tabs.page-tabs-glass` strip sits in a
`.table-head-row.folder-head-card` inside `.page-top-sticky`; one page-sized `.folder-card
.folder-body` holds every `.page-tab-panel` inside `.folder-card-scroll`, so panels scroll
INSIDE the card and its top edge never slides under the pinned header (`page-top-curtain.js`
draws the curtain). `server-settings.js` is only the shell: tab visibility
(`SETTINGS_TAB_PERMS` + `permAtLeast`), switching, `?tab=` persistence and lazy first-activation
loads; each tab's body is its own `server-settings-<tab>.js` module (the HA and Repository tabs
expose `window.*Tab.load()` and guard their own once-per-page load). Internal keys outlived
label changes: the Web Server tab is `data-tab="certificates"` and the Repository tab is
`firmware`. Script order: `theme-init.js` (head) → `page-top-curtain.js` → `settings-api.js` →
`folder-tabs.js` → `panel-lock.js` → `brand-logo.js` → `app.js` (+ the `#polaris-nav-ready`
marker right after it) → `settings-ui.js` → shared widgets
(`condition-builder.js`, `pinned-tls-certs.js`) → tab modules → `server-settings.js` last.
A new tab = a button + panel in the HTML, a module, a `SETTINGS_TAB_PERMS` row naming the key
its routes check, and a lazy-load line in `_activateSettingsTab()`.

### Modal open / closed state

The modal overlay toggles the `.open` class; a "closed" overlay can still be in the DOM. A test
or script asking "is the dialog closed?" reads `.modal-overlay.open`, not whether a field
exists.
