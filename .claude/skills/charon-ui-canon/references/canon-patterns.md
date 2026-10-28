# UI canon — tables, modals, toasts, tabs, TableSF

Moved verbatim from TEMPLATES.md (its frontend entries).

### Table / modal / toast (frontend)
**Ref:** `public/js/integrations.js` (cards + data-driven modal) and
`public/js/endpoints.js` (table + modal). Use `window.api.{get,post,put,patch,del}`,
`window.Charon.{init,toast,escapeHtml,can}`. Tabs: `public/js/server-settings.js`.
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

### Modal open / closed state

The modal overlay toggles the `.open` class; a "closed" overlay can still be in the DOM. A test
or script asking "is the dialog closed?" reads `.modal-overlay.open`, not whether a field
exists.
