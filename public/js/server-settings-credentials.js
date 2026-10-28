/**
 * public/js/server-settings-credentials.js — Server Settings: Credentials tab (credentials, MIB database, manufacturer aliases + profiles).
 * Ported from polaris public/js/server-settings.js (split per tab; every
 * declaration stays a page global, exactly as in the single polaris file).
 */

// ─── MIB Database card ─────────────────────────────────────────────────────

function _mibFilteredRows() {
  return _mibsData.filter(function (m) {
    if (_mibFilter.scope === "generic" && m.manufacturer) return false;
    if (_mibFilter.scope === "device" && !m.manufacturer) return false;
    if (_mibFilter.manufacturer && (m.manufacturer || "").toLowerCase() !== _mibFilter.manufacturer.toLowerCase()) return false;
    if (_mibFilter.model && (m.model || "").toLowerCase() !== _mibFilter.model.toLowerCase()) return false;
    return true;
  });
}

function _mibManufacturerOptions(selected) {
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All manufacturers</option>';
  (_mibFacets.manufacturers || []).forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

function _mibModelOptions(manufacturer, selected) {
  var models = (_mibFacets.modelsByManufacturer || {})[manufacturer] || [];
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All models</option>';
  models.forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

// ─── Manufacturer Aliases helpers ──────────────────────────────────────────
// (card HTML is inlined into renderIdentificationTab as part of the consolidated
// MAC & Vendor Identification card)

function wireManufacturerAliasControls() {
  var addBtn = document.getElementById("btn-add-alias");
  if (addBtn) addBtn.addEventListener("click", addManufacturerAlias);

  var container = document.getElementById("tab-identification");
  container.querySelectorAll(".alias-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
  container.querySelectorAll(".alias-edit").forEach(function (btn) {
    btn.addEventListener("click", function () {
      editManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
}

async function addManufacturerAlias() {
  var aliasInput = document.getElementById("f-alias-input");
  var canonicalInput = document.getElementById("f-alias-canonical");
  var alias = (aliasInput.value || "").trim();
  var canonical = (canonicalInput.value || "").trim();
  if (!alias || !canonical) {
    showToast("Both alias and canonical are required", "error");
    return;
  }
  try {
    await api.serverSettings.createManufacturerAlias({ alias: alias, canonical: canonical });
    aliasInput.value = "";
    canonicalInput.value = "";
    showToast('Alias "' + alias + '" → "' + canonical + '" added', "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to add alias", "error");
  }
}

async function deleteManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  var label = existing ? '"' + existing.alias + '" → "' + existing.canonical + '"' : "this alias";
  var ok = await showConfirm("Delete alias " + label + "?");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerAlias(id);
    showToast("Alias deleted", "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to delete alias", "error");
  }
}

function editManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  if (!existing) return;

  var body =
    '<div class="form-group"><label>Alias *</label>' +
      '<input type="text" id="f-edit-alias" value="' + escapeHtml(existing.alias) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Stored lowercased; matched case-insensitively against incoming manufacturer strings.</div>' +
    '</div>' +
    '<div class="form-group"><label>Canonical *</label>' +
      '<input type="text" id="f-edit-canonical" value="' + escapeHtml(existing.canonical) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Saving will rewrite existing assets and MIBs already stored under the previous canonical value.</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-alias">Save Changes</button>';
  openModal("Edit Manufacturer Alias", body, footer);

  document.getElementById("btn-save-alias").addEventListener("click", async function () {
    var btn = this;
    var alias = document.getElementById("f-edit-alias").value.trim();
    var canonical = document.getElementById("f-edit-canonical").value.trim();
    if (!alias || !canonical) {
      showToast("Both alias and canonical are required", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api.serverSettings.updateManufacturerAlias(id, { alias: alias, canonical: canonical });
      closeModal();
      showToast("Alias updated", "success");
      await loadIdentificationTab();
    } catch (err) {
      showToast(err.message || "Failed to update alias", "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function mibCardHTML() {
  var rows = _mibFilteredRows();
  var html = '<div class="settings-card">' +
    '<h4>MIB Database</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'SNMP MIB modules used to resolve vendor-specific OIDs during monitoring. ' +
      'Vendor profiles (Cisco, Juniper, Fortinet, …) are <b>universal</b> per-manufacturer, but you can also upload a <b>device-specific</b> MIB that overrides the vendor MIB for one model only. Resolution priority at probe time is <i>device → vendor → generic → built-in seed</i>. ' +
      'Files are validated as ASN.1/SMI on upload — anything else is rejected.' +
    '</p>';

  // (Vendor Profile Status pill removed — the editable Manufacturer
  // Profiles card is the canonical surface for per-manufacturer telemetry
  // resolution status.)

  // Filter row
  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:1rem">' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
        '<select id="f-mib-filter-mfr">' + _mibManufacturerOptions(_mibFilter.manufacturer) + '</select>' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Model</label>' +
        '<select id="f-mib-filter-model"' + (_mibFilter.manufacturer ? '' : ' disabled') + '>' +
          _mibModelOptions(_mibFilter.manufacturer, _mibFilter.model) +
        '</select>' +
      '</div>' +
      '<div style="flex:0 0 auto">' +
        '<label style="font-size:0.78rem;font-weight:500">Scope</label>' +
        '<select id="f-mib-filter-scope">' +
          '<option value="all"' + (_mibFilter.scope === "all" ? " selected" : "") + '>All</option>' +
          '<option value="device"' + (_mibFilter.scope === "device" ? " selected" : "") + '>Device-specific</option>' +
          '<option value="generic"' + (_mibFilter.scope === "generic" ? " selected" : "") + '>Generic only</option>' +
        '</select>' +
      '</div>' +
    '</div>';

  // List
  if (rows.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>Module</th><th>Manufacturer</th><th>Model</th><th>Imports</th><th style="width:90px;text-align:right">Size</th><th style="width:130px">Uploaded</th><th style="width:120px"></th>' +
    '</tr></thead><tbody>';
    rows.forEach(function (m) {
      var sizeKb = (m.size / 1024).toFixed(1) + " KB";
      var importsText = (m.imports && m.imports.length > 0) ? m.imports.length + " ref" + (m.imports.length === 1 ? "" : "s") : "—";
      var importsTitle = (m.imports && m.imports.length > 0) ? m.imports.join(", ") : "";
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(m.moduleName) + '</td>' +
        '<td>' + (m.manufacturer ? escapeHtml(m.manufacturer) : '<span style="color:var(--color-text-tertiary);font-style:italic">generic</span>') + '</td>' +
        '<td>' + (m.model ? escapeHtml(m.model) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
        '<td' + (importsTitle ? ' title="' + escapeHtml(importsTitle) + '"' : '') + ' style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(importsText) + '</td>' +
        '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(sizeKb) + '</td>' +
        '<td style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(formatDate(m.uploadedAt)) + '</td>' +
        '<td class="actions" style="white-space:nowrap;flex-wrap:nowrap">' +
          '<button class="btn btn-sm btn-primary mib-browse" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.moduleName) + '">Browse</button> ' +
          '<a class="btn btn-sm btn-secondary" href="' + api.serverSettings.downloadMibUrl(m.id) + '" download="' + escapeHtml(m.filename) + '">Download</a> ' +
          // Charon: MIB writes ride serverSettingsSystem:write (polaris: admin).
          (permAtLeast("serverSettingsSystem", "write")
            ? '<button class="btn btn-sm btn-danger mib-del" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.moduleName) + '">Del</button>'
            : '') +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
  } else if (_mibsData.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs uploaded yet. Add one below to start.</p>';
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs match the current filter.</p>';
  }

  // Upload form (admin only — assets-admin can browse + walk but not edit)
  // Charon: gated on serverSettingsSystem:write, the key the upload route checks.
  if (!permAtLeast("serverSettingsSystem", "write")) {
    html += '</div>';
    return html;
  }

  var modelListId = "mib-model-datalist";
  var modelOpts = "";
  Object.keys(_mibFacets.modelsByManufacturer || {}).forEach(function (mfr) {
    (_mibFacets.modelsByManufacturer[mfr] || []).forEach(function (md) {
      modelOpts += '<option value="' + escapeHtml(md) + '"></option>';
    });
  });

  html +=
    '<div style="border-top:1px solid var(--color-border);padding-top:1rem">' +
      '<h5 style="margin:0 0 0.75rem;font-size:0.9rem">Upload MIB</h5>' +
      '<datalist id="' + modelListId + '">' + modelOpts + '</datalist>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500;display:block;margin-bottom:0.25rem">Scope</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="vendor" checked> ' +
          '<b>Manufacturer-wide</b> &mdash; covers every model from this vendor (most common)' +
        '</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="device"> ' +
          '<b>Device-specific</b> &mdash; overrides the manufacturer-wide MIB for one model only' +
        '</label>' +
        '<label style="display:block;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="generic"> ' +
          '<b>Generic</b> &mdash; shared across all vendors (e.g. SNMPv2-SMI, IF-MIB)' +
        '</label>' +
      '</div>' +
      '<div id="mib-upload-vendor-fields" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0.75rem">' +
        '<div style="flex:1;min-width:160px">' +
          '<label style="font-size:0.78rem;font-weight:500">Manufacturer *</label>' +
          // The same open-on-click combobox as "+ Add Manufacturer": vendors
          // with devices in inventory first, each with its device count, since
          // a vendor MIB only resolves for assets whose manufacturer matches.
          '<span class="aw-combo aw-combo-dim">' +
            '<input type="text" id="f-mib-up-mfr" autocomplete="off" placeholder="e.g. Cisco">' +
            '<div class="aw-suggest" id="mib-up-mfr-suggest"></div>' +
          '</span>' +
        '</div>' +
        '<div id="mib-upload-model-field" style="flex:1;min-width:160px;display:none">' +
          '<label style="font-size:0.78rem;font-weight:500">Model *</label>' +
          '<input type="text" id="f-mib-up-model" list="' + modelListId + '" placeholder="e.g. Catalyst 9300">' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">MIB file *</label>' +
        '<input type="file" id="f-mib-up-file" accept=".mib,.txt,.my,.smi,text/plain">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">Notes <span style="color:var(--color-text-tertiary);font-weight:400">(optional)</span></label>' +
        '<input type="text" id="f-mib-up-notes" placeholder="Source URL, version, anything you want to remember">' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-primary" id="btn-mib-upload">Upload MIB</button>' +
        '<span id="mib-upload-status" style="font-size:0.82rem"></span>' +
      '</div>' +
    '</div>';

  html += '</div>';
  return html;
}

function wireMibControls() {
  var mfr = document.getElementById("f-mib-filter-mfr");
  var model = document.getElementById("f-mib-filter-model");
  var scope = document.getElementById("f-mib-filter-scope");
  if (mfr) {
    mfr.addEventListener("change", function () {
      _mibFilter.manufacturer = mfr.value || "";
      _mibFilter.model = ""; // reset model when manufacturer changes
      renderIdentificationTab();
    });
  }
  if (model) {
    model.addEventListener("change", function () {
      _mibFilter.model = model.value || "";
      renderIdentificationTab();
    });
  }
  if (scope) {
    scope.addEventListener("change", function () {
      _mibFilter.scope = scope.value || "all";
      renderIdentificationTab();
    });
  }

  document.querySelectorAll("input[name='mib-scope-up']").forEach(function (r) {
    r.addEventListener("change", function () {
      var fields = document.getElementById("mib-upload-vendor-fields");
      var modelField = document.getElementById("mib-upload-model-field");
      if (!fields || !modelField) return;
      if (!r.checked) return;
      if (r.value === "generic") {
        fields.style.display = "none";
      } else {
        fields.style.display = "flex";
        modelField.style.display = r.value === "device" ? "block" : "none";
      }
    });
  });

  var btn = document.getElementById("btn-mib-upload");
  if (btn) btn.addEventListener("click", uploadMibUI);
  wireMibUploadManufacturerCombo();

  document.querySelectorAll(".mib-del").forEach(function (b) {
    b.addEventListener("click", function () {
      deleteMibUI(b.getAttribute("data-id"), b.getAttribute("data-name"));
    });
  });

  document.querySelectorAll(".mib-browse").forEach(function (b) {
    b.addEventListener("click", function () {
      openMibBrowseModal(b.getAttribute("data-id"), b.getAttribute("data-name"));
    });
  });
}

async function uploadMibUI() {
  var fileInput = document.getElementById("f-mib-up-file");
  var statusEl = document.getElementById("mib-upload-status");
  var btn = document.getElementById("btn-mib-upload");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast("Choose a MIB file first", "error");
    return;
  }
  var scopeRadio = document.querySelector("input[name='mib-scope-up']:checked");
  var scope = scopeRadio ? scopeRadio.value : "vendor";
  var fields = {};
  if (scope === "vendor" || scope === "device") {
    var mfr = (document.getElementById("f-mib-up-mfr").value || "").trim();
    if (!mfr) { showToast("Manufacturer is required for manufacturer-wide and device-specific MIBs", "error"); return; }
    fields.manufacturer = mfr;
  }
  if (scope === "device") {
    var model = (document.getElementById("f-mib-up-model").value || "").trim();
    if (!model) { showToast("Model is required for device-specific MIBs", "error"); return; }
    fields.model = model;
  }
  var notes = (document.getElementById("f-mib-up-notes").value || "").trim();
  if (notes) fields.notes = notes;

  btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Uploading…</span>';
  try {
    var created = await api.serverSettings.uploadMib(fileInput.files[0], fields);
    showToast("MIB uploaded: " + created.moduleName, "success");
    // Say whether the module is USABLE where it landed, not just stored. A
    // vendor leaf module uploaded without its core module resolves nothing,
    // and until 2026-09 the operator found that out from a chart that never
    // filled. Stays on screen until the next upload or re-render.
    if (statusEl) statusEl.innerHTML = _mibUploadResultHTML(created);
    // Refresh list + facets + profile status
    var [list, facets] = await Promise.all([
      api.serverSettings.listMibs(),
      api.serverSettings.getMibFacets(),
    ]);
    _mibsData = list || [];
    _mibFacets = facets || { manufacturers: [], modelsByManufacturer: {} };
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function deleteMibUI(id, name) {
  var ok = await showConfirm('Delete MIB module "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteMib(id);
    _mibsData = _mibsData.filter(function (m) { return m.id !== id; });
    showToast("MIB deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── MIB Browse modal ─────────────────────────────────────────────────────
//
// Two-pane modal: left = collapsible sections (Tables, Scalars / Other);
// right = selected object detail + "Walk on asset…" pivot. Walk results
// render scalars as a flat list and tables as a 2D table with column
// headers from the MIB and rows keyed by the SMI INDEX. Symbolic + decoded
// values (INTEGER enums → up(1), TimeTicks → human duration) come from
// the server — the client just renders.

var _mibBrowseState = null; // { mibId, structure, selectedSymbol, walkOpen, asset, credentialId }

async function openMibBrowseModal(mibId, moduleName) {
  // Open shell with a loading state so the modal feels responsive even
  // while the structured parse + OID resolution roll back.
  var title = "Browse MIB" + (moduleName ? " — " + moduleName : "");
  openModal(title, '<p class="empty-state">Loading MIB structure…</p>', '<button class="btn btn-secondary" onclick="closeModal()">Close</button>', { xl: true });

  var structure;
  try {
    structure = await api.serverSettings.getMibStructure(mibId);
  } catch (err) {
    var msg = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Failed to load MIB structure") + '</p>';
    document.querySelector(".modal-body").innerHTML = msg;
    return;
  }

  _mibBrowseState = {
    mibId: mibId,
    moduleName: structure.moduleName || moduleName,
    structure: structure,
    selectedSymbol: null,
    asset: null,
    credentialId: null,
  };

  renderMibBrowseModal();
}

function renderMibBrowseModal() {
  var s = _mibBrowseState;
  if (!s) return;
  var st = s.structure;

  var unresolvedNote = "";
  if (st.unresolvedCount > 0) {
    // Name the missing anchor when the server could identify it. A MIB whose
    // root is an IMPORTed symbol fails wholesale rather than partially, so the
    // bare count reads as "this MIB is broken" when the actual fix is usually
    // "upload the one module that defines <symbol>".
    // `unresolvedRootDetails` pairs each root with the module the file's own
    // IMPORTS says defines it, so the fix can be named outright.
    var details = Array.isArray(st.unresolvedRootDetails) ? st.unresolvedRootDetails : [];
    var roots = details.length > 0
      ? details.map(function (d) { return d.symbol; })
      : (Array.isArray(st.unresolvedRoots) ? st.unresolvedRoots : []);
    var modules = [];
    details.forEach(function (d) { if (d.module && modules.indexOf(d.module) === -1) modules.push(d.module); });
    var cause = roots.length > 0
      ? ' Undefined here: <b>' + roots.map(escapeHtml).join("</b>, <b>") + '</b>' +
        (modules.length > 0
          ? ' — upload <b>' + modules.map(escapeHtml).join("</b>, <b>") + '</b>' + (roots.length === 1 ? ', which defines it.' : ', which define them.')
          : ' — upload the MIB that defines ' + (roots.length === 1 ? 'it' : 'them') + '.')
      : (Array.isArray(st.imports) && st.imports.length > 0
          ? ' This MIB imports from: ' + st.imports.map(escapeHtml).join(", ")
          : '');
    unresolvedNote =
      '<div style="margin:0 0 0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--color-warning,#d97706);border-radius:4px;background:rgba(217,119,6,0.06);font-size:0.82rem">' +
        '<b>' + st.unresolvedCount + '</b> symbol' + (st.unresolvedCount === 1 ? '' : 's') + ' could not be resolved to a numeric OID — likely a missing IMPORTS dependency.' +
        cause +
      '</div>';
  }

  var leftPane =
    unresolvedNote +
    _mibBrowseTablesSection(st) +
    _mibBrowseScalarsSection(st);

  var rightPane = _mibBrowseDetailPane();

  var body =
    '<div style="display:grid;grid-template-columns:minmax(280px,38%) 1fr;gap:1rem;height:70vh;overflow:hidden;padding:1rem">' +
      '<div id="mib-browse-left" style="overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;height:100%;border-right:1px solid var(--color-border);padding-right:0.75rem">' + leftPane + '</div>' +
      '<div id="mib-browse-right" style="overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;height:100%">' + rightPane + '</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
  openModal("Browse MIB — " + (s.moduleName || ""), body, footer, { xl: true });

  // Wire object selection
  document.querySelectorAll(".mib-browse-symbol").forEach(function (el) {
    el.addEventListener("click", function () {
      var name = el.getAttribute("data-name");
      _mibBrowseState.selectedSymbol = name;
      renderMibBrowseModal();
    });
  });

  // Wire collapsibles
  document.querySelectorAll(".mib-browse-section-toggle").forEach(function (h) {
    h.addEventListener("click", function () {
      var sec = h.parentElement;
      sec.classList.toggle("collapsed");
      var caret = h.querySelector(".caret");
      if (caret) caret.textContent = sec.classList.contains("collapsed") ? "▸" : "▾";
    });
  });

  // Wire "Walk on asset…" if visible
  var walkBtn = document.getElementById("btn-mib-walk-open");
  if (walkBtn) walkBtn.addEventListener("click", _mibBrowseOpenWalk);
}

function _mibBrowseTablesSection(st) {
  if (!st.tables || st.tables.length === 0) return "";
  var rows = st.tables.map(function (t) {
    var colCount = t.columns ? t.columns.length : 0;
    return '<div class="mib-browse-symbol" data-name="' + escapeHtml(t.name) + '" style="padding:0.4rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono)">' +
      escapeHtml(t.name) +
      ' <span style="color:var(--color-text-tertiary);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">(' + colCount + ' col' + (colCount === 1 ? '' : 's') + ')</span>' +
    '</div>';
  }).join("");
  return _mibBrowseSection("Tables", rows, false);
}

function _mibBrowseScalarsSection(st) {
  // Anything not a known table column or table-row entry goes here.
  var tableColumns = new Set();
  var tableRows = new Set();
  (st.tables || []).forEach(function (t) {
    tableRows.add(t.rowSymbol);
    (t.columns || []).forEach(function (c) { tableColumns.add(c); });
  });
  // Surface every other symbol — scalars + group nodes (OBJECT IDENTIFIER
  // shorthand) all belong here. Filter out the table objects themselves
  // (they appear in the Tables section already).
  var tableNames = new Set((st.tables || []).map(function (t) { return t.name; }));
  var rows = (st.symbols || [])
    .filter(function (s) {
      return !tableColumns.has(s.name) && !tableRows.has(s.name) && !tableNames.has(s.name);
    })
    .map(function (s) {
      var typeBadge = s.baseType && s.baseType !== "OTHER" && s.baseType !== "OBJECT IDENTIFIER"
        ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">' + escapeHtml(s.baseType) + '</span>'
        : '';
      var unresolved = s.fullOid === null
        ? ' <span style="color:var(--color-warning,#d97706);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">(unresolved)</span>'
        : '';
      return '<div class="mib-browse-symbol" data-name="' + escapeHtml(s.name) + '" style="padding:0.4rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono)">' +
        escapeHtml(s.name) + typeBadge + unresolved +
      '</div>';
    }).join("");
  if (!rows) return "";
  return _mibBrowseSection("Scalars / Other", rows, false);
}

function _mibBrowseSection(title, innerHTML, startCollapsed) {
  return '<div class="mib-browse-section' + (startCollapsed ? ' collapsed' : '') + '" style="margin-bottom:0.75rem">' +
    '<h5 class="mib-browse-section-toggle" style="margin:0 0 0.25rem;font-size:0.85rem;font-weight:600;cursor:pointer;user-select:none;padding:0.35rem 0.5rem;background:var(--color-surface-alt,rgba(127,127,127,0.05));border-radius:4px">' +
      '<span class="caret" style="display:inline-block;width:1em">' + (startCollapsed ? '▸' : '▾') + '</span>' +
      escapeHtml(title) +
    '</h5>' +
    '<div class="mib-browse-section-body">' + innerHTML + '</div>' +
  '</div>';
}

function _mibBrowseDetailPane() {
  var s = _mibBrowseState;
  if (!s) return "";
  var st = s.structure;
  if (!s.selectedSymbol) {
    return '<p class="empty-state" style="margin-top:1rem">Pick an object on the left to see its details and run a walk.</p>';
  }

  // The selected entry is either a top-level symbol OR a MibTable. Tables
  // live in their own array; everything else lives in symbols. Detail
  // rendering differs slightly between them.
  var table = (st.tables || []).find(function (t) { return t.name === s.selectedSymbol; });
  if (table) return _mibBrowseTableDetail(table, st);
  var sym = (st.symbols || []).find(function (x) { return x.name === s.selectedSymbol; });
  if (!sym) return '<p class="empty-state">Symbol not found.</p>';
  return _mibBrowseScalarDetail(sym);
}

function _mibBrowseScalarDetail(sym) {
  var rows = [
    ["OID", sym.fullOid ? sym.fullOid : '<span style="color:var(--color-warning,#d97706)">unresolved</span>'],
    ["Kind", sym.kind || ""],
    ["Syntax", sym.syntax ? escapeHtml(sym.syntax) : "—"],
    ["Base type", sym.baseType || ""],
    ["Access", sym.access || "—"],
    ["Status", sym.status || "—"],
  ];
  var rowsHtml = rows.map(function (r) {
    return '<tr><th style="text-align:left;padding:0.25rem 0.75rem 0.25rem 0;font-weight:500;color:var(--color-text-secondary);width:8rem">' + escapeHtml(r[0]) + '</th>' +
      '<td class="mono" style="padding:0.25rem 0;font-size:0.85rem">' + r[1] + '</td></tr>';
  }).join("");

  var enumHtml = "";
  if (sym.enumValues && sym.enumValues.length > 0) {
    enumHtml = '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Enum values</b>' +
      '<table class="ip-table" style="margin-top:0.25rem;font-size:0.85rem">' +
        '<thead><tr><th>Label</th><th style="width:80px;text-align:right">Value</th></tr></thead>' +
        '<tbody>' +
          sym.enumValues.map(function (e) {
            return '<tr><td class="mono">' + escapeHtml(e.label) + '</td><td style="text-align:right">' + e.value + '</td></tr>';
          }).join("") +
        '</tbody>' +
      '</table></div>';
  }

  var descHtml = sym.description
    ? '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Description</b><p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.25rem 0 0;white-space:pre-wrap">' + escapeHtml(sym.description) + '</p></div>'
    : "";

  var canWalk = sym.fullOid && (sym.access === "read-only" || sym.access === "read-write" || sym.access === "read-create");
  var walkBtn = canWalk
    ? '<button class="btn btn-primary" id="btn-mib-walk-open" style="margin-top:1rem">Walk on device…</button>'
    : '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem">' +
        (sym.fullOid ? 'Not a readable object — only read-only / read-write / read-create symbols can be walked.' : 'Cannot walk — OID is unresolved.') +
      '</p>';

  return '<h4 style="margin:0 0 0.5rem;font-family:var(--font-mono)">' + escapeHtml(sym.name) + '</h4>' +
    '<table style="font-size:0.82rem;width:100%"><tbody>' + rowsHtml + '</tbody></table>' +
    enumHtml + descHtml +
    walkBtn +
    _mibBrowseWalkPanel();
}

function _mibBrowseTableDetail(table, st) {
  // Pick the first column with read access as the default walk target,
  // since the table object itself is `not-accessible` (it can't be GET'd).
  var firstReadable = (table.columns || [])
    .map(function (col) { return (st.symbols || []).find(function (s) { return s.name === col; }); })
    .find(function (s) {
      return s && s.fullOid && (s.access === "read-only" || s.access === "read-write" || s.access === "read-create");
    });

  var colsHtml = (table.columns || []).map(function (col) {
    var sym = (st.symbols || []).find(function (x) { return x.name === col; });
    var typeBadge = sym && sym.baseType && sym.baseType !== "OTHER" ? sym.baseType : "—";
    var enumBadge = sym && sym.enumValues && sym.enumValues.length > 0 ? ' enum(' + sym.enumValues.length + ')' : '';
    return '<tr><td class="mono mib-browse-symbol" data-name="' + escapeHtml(col) + '" style="padding:0.25rem 0.5rem;cursor:pointer">' + escapeHtml(col) + '</td>' +
      '<td style="padding:0.25rem 0.5rem;color:var(--color-text-secondary);font-size:0.82rem">' + escapeHtml(typeBadge) + escapeHtml(enumBadge) + '</td></tr>';
  }).join("");

  // For a table, the operator typically wants to walk the WHOLE table, so
  // we make the Walk button target the first readable column. The walk
  // endpoint then groups the multi-column results back into a 2D table.
  // (Walking the table object itself works too — the response gets matched
  // against every column. But not-accessible parents sometimes confuse
  // certain SNMP agents, so we lean on the first column.)
  var walkBtn = "";
  if (firstReadable) {
    walkBtn =
      '<button class="btn btn-primary" id="btn-mib-walk-open" data-target="' + escapeHtml(firstReadable.name) + '" style="margin-top:1rem">Walk this table on device…</button>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">Walks <b>' + escapeHtml(firstReadable.name) + '</b> as the table entry — results are grouped into a 2D table by the SMI <code>INDEX</code>.</p>';
  } else {
    walkBtn = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem">No readable columns — table cannot be walked.</p>';
  }

  var indexHtml = (table.indexNames && table.indexNames.length > 0)
    ? '<div style="margin-top:0.5rem;font-size:0.85rem"><b>INDEX:</b> <span class="mono">' + table.indexNames.map(escapeHtml).join(", ") + '</span></div>'
    : "";

  var descHtml = table.description
    ? '<div style="margin-top:0.5rem"><b style="font-size:0.85rem">Description</b><p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.25rem 0 0;white-space:pre-wrap">' + escapeHtml(table.description) + '</p></div>'
    : "";

  return '<h4 style="margin:0 0 0.5rem;font-family:var(--font-mono)">' + escapeHtml(table.name) +
    ' <span style="font-family:inherit;font-size:0.85rem;color:var(--color-text-tertiary);font-weight:400">(SMI table)</span></h4>' +
    indexHtml + descHtml +
    '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Columns (click to view)</b>' +
      '<table class="ip-table" style="margin-top:0.25rem;font-size:0.85rem"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>' + colsHtml + '</tbody></table>' +
    '</div>' +
    walkBtn +
    _mibBrowseWalkPanel();
}

function _mibBrowseWalkPanel() {
  // A persistent slot at the bottom of the right pane that the walk pivot
  // populates inline. Keeps the asset picker + results visible alongside
  // the symbol detail without opening a second modal.
  return '<div id="mib-walk-panel" style="margin-top:1.25rem;display:none;border-top:1px solid var(--color-border);padding-top:0.75rem"></div>';
}

function _mibBrowseOpenWalk(ev) {
  // The button on a table-detail view stamps `data-target` with a column
  // symbol name. Scalar-detail views walk the selected symbol directly.
  var btn = ev && ev.currentTarget ? ev.currentTarget : null;
  var targetName = btn && btn.getAttribute("data-target");
  var symbolName = targetName || _mibBrowseState.selectedSymbol;

  var panel = document.getElementById("mib-walk-panel");
  if (!panel) return;
  panel.style.display = "block";
  panel.innerHTML =
    '<h5 style="margin:0 0 0.5rem">Walk <span class="mono">' + escapeHtml(symbolName) + '</span></h5>' +
    // Charon: no Asset inventory — the walk targets a typed host instead of
    // a searched asset (the server validates it like Test Connection does).
    '<div class="form-group" style="margin-bottom:0.5rem">' +
      '<label style="font-size:0.78rem;font-weight:500">IP address or hostname</label>' +
      '<input type="text" id="f-mib-walk-host" autocomplete="off" spellcheck="false" placeholder="10.20.30.40">' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:0.5rem">' +
      '<label style="font-size:0.78rem;font-weight:500">SNMP credential</label>' +
      '<select id="f-mib-walk-cred" disabled><option value="">Loading credentials…</option></select>' +
    '</div>' +
    '<div style="display:flex;gap:0.5rem;align-items:center">' +
      '<button class="btn btn-primary" id="btn-mib-walk-run" disabled>Run Walk</button>' +
      '<span id="mib-walk-status" style="font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
    '</div>' +
    '<div id="mib-walk-result" style="margin-top:0.75rem"></div>';

  _wireMibWalkPanel(symbolName);

  // Auto-scroll the panel into view
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function _wireMibWalkPanel(symbolName) {
  // Charon adaptation: polaris searches assets (api.assets.list) and posts an
  // assetId; Charon has no inventory, so the operator types the host and the
  // walk posts { host }. Everything after the target is polaris verbatim.
  var hostInput   = document.getElementById("f-mib-walk-host");
  var credSelect  = document.getElementById("f-mib-walk-cred");
  var runBtn      = document.getElementById("btn-mib-walk-run");
  var statusEl    = document.getElementById("mib-walk-status");
  var resultBox   = document.getElementById("mib-walk-result");

  // Load SNMP credentials from the shared list
  api.credentials.list().then(function (creds) {
    var snmp = (creds || []).filter(function (c) { return c.type === "snmp"; });
    if (snmp.length === 0) {
      credSelect.innerHTML = '<option value="">No SNMP credentials configured</option>';
      credSelect.disabled = true;
      return;
    }
    credSelect.innerHTML =
      '<option value="">Select a credential…</option>' +
      snmp.map(function (c) {
        return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
      }).join("");
    credSelect.disabled = false;
  }).catch(function () {
    credSelect.innerHTML = '<option value="">Failed to load credentials</option>';
  });

  function typedHost() { return (hostInput.value || "").trim(); }
  function refreshRunState() {
    runBtn.disabled = !(typedHost() && credSelect.value);
  }
  credSelect.addEventListener("change", refreshRunState);
  hostInput.addEventListener("input", refreshRunState);
  hostInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !runBtn.disabled) { e.preventDefault(); runBtn.click(); }
  });

  runBtn.addEventListener("click", async function () {
    if (!typedHost() || !credSelect.value) return;
    runBtn.disabled = true;
    statusEl.textContent = "Walking…";
    resultBox.innerHTML = "";
    try {
      var result = await api.serverSettings.walkMib(_mibBrowseState.mibId, {
        host: typedHost(),
        credentialId: credSelect.value,
        objectName: symbolName,
      });
      statusEl.textContent =
        result.rowCount + " row" + (result.rowCount === 1 ? '' : 's') +
        ' in ' + result.durationMs + ' ms' +
        (result.truncated ? ' (truncated)' : '');
      resultBox.innerHTML = _renderProfileMibWalkResult(result);
      _wireMibWalkCopy(result);
    } catch (err) {
      statusEl.textContent = "";
      resultBox.innerHTML = '<div style="padding:0.5rem 0.75rem;border:1px solid var(--color-danger);border-radius:4px;color:var(--color-danger);font-size:0.85rem">' + escapeHtml(err.message || "Walk failed") + '</div>';
    } finally {
      refreshRunState();
    }
  });

  setTimeout(function () { hostInput.focus(); }, 50);
}

function _renderProfileMibWalkResult(result) {
  if (!result || !result.kind) return "";
  var mismatchBanner = "";
  if (result.rowCount > 0 && result.decodedCount * 2 < result.rowCount) {
    var pct = Math.round((result.decodedCount / result.rowCount) * 100);
    mismatchBanner =
      '<div style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--color-warning,#d97706);border-radius:4px;background:rgba(217,119,6,0.06);font-size:0.82rem">' +
        'Decoded ' + result.decodedCount + ' / ' + result.rowCount + ' rows (' + pct + '%). This MIB may not match the asset\'s manufacturer.' +
      '</div>';
  }

  if (result.kind === "table" && result.table) {
    var t = result.table;
    var thead =
      '<thead><tr>' +
        (t.indexNames && t.indexNames.length > 0
          ? '<th style="font-family:var(--font-mono)">' + t.indexNames.map(escapeHtml).join(", ") + '</th>'
          : '<th style="font-family:var(--font-mono)">index</th>') +
        t.columns.map(function (c) { return '<th style="font-family:var(--font-mono)">' + escapeHtml(c) + '</th>'; }).join("") +
      '</tr></thead>';
    var tbody = '<tbody>' + t.rows.map(function (row) {
      var cells = t.columns.map(function (col) {
        var c = row.cells[col];
        if (!c) return '<td style="color:var(--color-text-tertiary)">—</td>';
        var title = c.decoded !== c.raw ? ' title="raw: ' + escapeHtml(c.raw) + '"' : '';
        return '<td' + title + '>' + escapeHtml(c.decoded) + '</td>';
      }).join("");
      return '<tr><td class="mono">' + escapeHtml(row.index) + '</td>' + cells + '</tr>';
    }).join("") + '</tbody>';
    return mismatchBanner +
      '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">' +
        '<button class="btn btn-sm btn-secondary" id="btn-mib-walk-copy">Copy results</button>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Hover any cell for the raw value.</span>' +
      '</div>' +
      '<div style="overflow-x:auto"><table class="ip-table" style="font-size:0.82rem">' + thead + tbody + '</table></div>';
  }

  // Scalars
  var entries = result.entries || [];
  if (entries.length === 0) {
    return '<p class="empty-state">No rows returned.</p>';
  }
  var rows = entries.map(function (e) {
    var label = e.symbol ? e.symbol + (e.suffix ? '.' + e.suffix : '') : e.oid;
    var decoded = e.decoded;
    var raw = e.raw;
    var rawNote = decoded !== raw ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">(' + escapeHtml(raw) + ')</span>' : '';
    return '<tr>' +
      '<td class="mono" style="font-size:0.85rem">' + escapeHtml(label) + '</td>' +
      '<td>' + escapeHtml(decoded) + rawNote + '</td>' +
      '<td style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(e.baseType || "") + '</td>' +
    '</tr>';
  }).join("");

  return mismatchBanner +
    '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">' +
      '<button class="btn btn-sm btn-secondary" id="btn-mib-walk-copy">Copy results</button>' +
    '</div>' +
    '<table class="ip-table" style="font-size:0.85rem">' +
      '<thead><tr><th>Object</th><th>Value</th><th>Type</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

function _wireMibWalkCopy(result) {
  var btn = document.getElementById("btn-mib-walk-copy");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var text;
    if (result.kind === "table" && result.table) {
      var t = result.table;
      var headers = ["index"].concat(t.columns).join("\t");
      var lines = t.rows.map(function (row) {
        return [row.index].concat(t.columns.map(function (col) {
          return row.cells[col] ? row.cells[col].decoded : "";
        })).join("\t");
      });
      text = headers + "\n" + lines.join("\n");
    } else {
      var entries = result.entries || [];
      text = entries.map(function (e) {
        var label = e.symbol ? e.symbol + (e.suffix ? '.' + e.suffix : '') : e.oid;
        return label + "\t" + e.decoded + "\t" + (e.baseType || "");
      }).join("\n");
    }
    copyTextToClipboard(text).then(function (ok) {
      showToast(ok ? "Walk results copied" : "Copy failed — select and copy by hand", ok ? "success" : "error");
    });
  });
}


// ─── Credentials Tab ───────────────────────────────────────────────────────

var _credsLoaded = false;
var _credsData = [];
// credential id → count of assets effectively using it (asset/class/integration
// tiers resolved server-side). Drives the Assets column + click-through slide-in.
var _credUsageCounts = {};
// Mask sentinel must match the server's credentialService.MASK. Secrets
// arrive pre-masked from GET; the server preserves the real value on PUT
// whenever the mask (or an empty string) is resubmitted.
var _credMask = "••••••••";

async function loadCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';
  try {
    // Assets-admin loads only the MIB-related endpoints (the only ones the
    // backend opens to them). admin gets the full set — credentials list,
    // MIBs + facets (for the MIB Database card), and manufacturer profiles.
    //
    // `credentials=write` also loads the credential list: that level owns
    // "add credentials, edit your own" (the ownership dimension), so the card
    // it manages can't be admin-gated any more. The MIB / profile calls in
    // the same batch already swallow their own 403s, and both those cards
    // still render for admin only.
    // Charon: "admin" here = serverSettingsSystem:read (the MIB / profile
    // routes' gate), and the credential list tolerates a 403 — a role can hold
    // serverSettingsSystem without the credentials key.
    var adminUser = permAtLeast("serverSettingsSystem", "read");
    var mayWriteCreds = _credsWritable();
    if (adminUser || mayWriteCreds) {
      var results = await Promise.all([
        api.credentials.list().catch(function () { return []; }),
        api.serverSettings.listMibs().catch(function () { return []; }),
        api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
        api.serverSettings.listManufacturerProfiles().catch(function () { return { profiles: [], transforms: [] }; }),
        api.credentials.usageCounts().catch(function () { return {}; }),
      ]);
      _credsData = results[0] || [];
      _mibsData = results[1] || [];
      _mibFacets = results[2] || { manufacturers: [], modelsByManufacturer: {} };
      _credUsageCounts = results[4] || {};
      var profilePayload = results[3] || {};
      _mfgProfiles = profilePayload.profiles || [];
      _mfgProfileTransforms = profilePayload.transforms || [];
      _mfgProfileCombiners = profilePayload.combiners || [];
      _mfgMetricTransforms = profilePayload.metricTransforms || {};
    } else {
      // Assets-admin: MIB Database card only. Credentials list + Manufacturer
      // Profiles stay admin-only — gated below in renderCredentialsTab().
      var mibResults = await Promise.all([
        api.serverSettings.listMibs().catch(function () { return []; }),
        api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
      ]);
      _credsData = [];
      _mibsData = mibResults[0] || [];
      _mibFacets = mibResults[1] || { manufacturers: [], modelsByManufacturer: {} };
    }
    _credsLoaded = true;
    renderCredentialsTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function credTypeLabel(t) {
  if (t === "snmp")    return "SNMP";
  if (t === "winrm")   return "WinRM";
  if (t === "ssh")     return "SSH";
  if (t === "restapi") return "REST API";
  if (t === "http")    return "HTTP";
  return t;
}

function credSummary(c) {
  var cfg = c.config || {};
  if (c.type === "snmp") {
    if (cfg.version === "v3") return "v3 · " + escapeHtml(cfg.username || "") + " · " + escapeHtml(cfg.securityLevel || "");
    return "v2c · community set";
  }
  if (c.type === "winrm") {
    return escapeHtml(cfg.username || "") + (cfg.useHttps ? " · HTTPS" : "");
  }
  if (c.type === "ssh") {
    var hasKey = typeof cfg.privateKey === "string" && cfg.privateKey;
    var auth = hasKey ? "private key" : "password";
    if (hasKey && typeof cfg.passphrase === "string" && cfg.passphrase) auth += " (encrypted)";
    return escapeHtml(cfg.username || "") + " · " + auth +
      (cfg.verifyHostKey === false ? " · host key NOT verified" : " · host key pinned") +
      (cfg.allowReboot === true ? " · reboots allowed" : "");
  }
  if (c.type === "restapi") {
    var url = cfg.baseUrl || "";
    var verifyTls = cfg.verifyTls === true ? "verify TLS" : "skip TLS";
    return escapeHtml(url) + " · " + verifyTls + (cfg.allowReboot === true ? " · reboots allowed" : "");
  }
  if (c.type === "http") {
    // Summarize the AUTH, which is all this credential is since the check moved
    // to a manufacturer widget. It used to lead with the request line and the
    // expectation — with those fields stripped that rendered as a FICTIONAL
    // "http://<device>/ · expect 2xx" for every row, describing a check the
    // credential no longer defines.
    var mode = httpAuthModeOf(cfg);
    if (mode === "bearer") return "bearer token";
    if (mode === "basic")  return escapeHtml(cfg.username || "") + " · basic";
    if (mode === "digest") return escapeHtml(cfg.username || "") + " · digest";
    return "no authentication";
  }
  return "";
}

// Any role with `credentials=write` manages the Stored Credentials card —
// their own rows at write, everyone's at fullwrite (the ownership dimension).
function _credsWritable() {
  if (typeof permAtLeast === "function") return permAtLeast("credentials", "write");
  return !(typeof isAdmin === "function" && !isAdmin());
}

// Ownership check for ONE row, shared with the server's assertOwnership: null
// createdBy is unowned (rows predating the column) and fullwrite-only.
function _credEditable(c) {
  if (typeof canEditCredential === "function") return canEditCredential(c);
  return _credsWritable();
}

function renderCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  // Charon: the Manufacturer Profiles card (polaris: admin-only) renders for
  // serverSettingsSystem:write, the key its write routes check.
  var adminUser = permAtLeast("serverSettingsSystem", "write");
  var mayWriteCreds = _credsWritable();

  var html = "";

  // ── 1. Stored Credentials (credentials=write; own rows only below fullwrite) ──
  if (mayWriteCreds) {
    var rows = _credsData.map(function (c) {
      var n = _credUsageCounts[c.id] || 0;
      var assetsCell = n > 0
        ? '<button type="button" data-action="usage" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '" title="Show the assets using this credential" ' +
            'style="background:none;border:none;padding:0;cursor:pointer;color:var(--color-accent);font:inherit;text-decoration:underline">' + n + '</button>'
        : '<span style="color:var(--color-text-secondary)">0</span>';
      // Editing, deleting and TESTING are all ownership-scoped — testing
      // because passing the row's id merges its stored secrets into the
      // probe, so it is "borrow this password", not a read.
      var mine = _credEditable(c);
      var lock = mine ? "" : " disabled";
      var lockTitle = mine ? "" :
        ' title="' + escapeHtml(c.createdBy
          ? ("Owned by " + c.createdBy + " — needs Full Read-Write on Credentials")
          : "No recorded owner — needs Full Read-Write on Credentials") + '"';
      var ownerCell = c.createdBy
        ? escapeHtml(c.createdBy)
        : '<span style="color:var(--color-text-tertiary)" title="Created before credentials had an owner — only Full Read-Write can edit it">&mdash;</span>';
      return '<tr>' +
        '<td>' + escapeHtml(c.name) + '</td>' +
        '<td>' + credTypeLabel(c.type) + '</td>' +
        '<td style="color:var(--color-text-secondary);font-size:0.85rem">' + credSummary(c) + '</td>' +
        '<td style="color:var(--color-text-secondary);font-size:0.85rem">' + ownerCell + '</td>' +
        '<td>' + assetsCell + '</td>' +
        '<td style="text-align:right">' +
          '<button class="btn btn-sm btn-secondary" data-action="edit" data-id="' + escapeHtml(c.id) + '"' + lock + lockTitle + '>Edit</button> ' +
          '<button class="btn btn-sm btn-secondary" data-action="test" data-id="' + escapeHtml(c.id) + '"' + lock + lockTitle + '>Test</button> ' +
          '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '"' + lock + lockTitle + '>Delete</button>' +
        '</td>' +
      '</tr>';
    }).join("");

    html +=
      '<div class="settings-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">' +
          '<h4 style="margin:0">Stored Credentials</h4>' +
          '<button class="btn btn-primary btn-sm" id="btn-cred-new">Add Credential</button>' +
        '</div>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Named credentials for asset monitoring probes. ' +
          'SNMP (v2c/v3), WinRM, and SSH credentials can be reused across assets. ' +
          'ICMP needs no credentials, and FortiManager-discovered firewalls reuse the direct-mode API token configured on their integration.' +
          ((typeof permAtLeast === "function" && !permAtLeast("credentials", "fullwrite"))
            ? '<br><span style="color:var(--color-text-tertiary)">You can edit, delete and test the credentials you created; the rest are listed read-only.</span>'
            : '') +
        '</p>' +
        (_credsData.length === 0
          ? '<p class="empty-state">No credentials yet. Click "Add Credential" to create one.</p>'
          : '<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Details</th><th>Owner</th><th>Assets</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
      '</div>';
  }

  // ── 2. MIB Database (admin OR assets-admin) ──
  html += mibCardHTML();

  // ── 3. Manufacturer Profiles (admin-only) ──
  if (adminUser) {
    html += manufacturerProfilesCardHTML();
  }

  container.innerHTML = html;

  // Wire credentials list controls only when rendered.
  if (mayWriteCreds) {
    document.getElementById("btn-cred-new").addEventListener("click", function () { openCredentialModal(null); });
    container.querySelectorAll('button[data-action="edit"]').forEach(function (btn) {
      btn.addEventListener("click", function () { openCredentialModal(btn.getAttribute("data-id")); });
    });
    container.querySelectorAll('button[data-action="test"]').forEach(function (btn) {
      btn.addEventListener("click", function () { testCredentialFromList(btn.getAttribute("data-id")); });
    });
    container.querySelectorAll('button[data-action="delete"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteCredential(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
      });
    });
    container.querySelectorAll('button[data-action="usage"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        openCredUsagePanel(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
      });
    });
  }

  // MIB controls (browse/upload/delete) — admin-only writes enforced by the
  // backend; admin-or-assets-admin reads.
  wireMibControls();

  // Manufacturer profile controls (admin-only) — only rendered above for admin.
  if (adminUser) {
    wireManufacturerProfileControls();
  }
}

// ─── Tag assets slide-in ─────────────────────────────────────────────────────
// Clicking a chip in the Tags card lists the assets carrying exactly that tag
// (GET /assets/by-tag). Same shape as the credential-usage slide-in below; a
// row opens the asset panel in place through PolarisPanels.
var _tagAssetsReturnFocus = null;
var _tagAssetsCurrent = null;

function _ensureTagAssetsPanelDOM() {
  if (document.getElementById("tag-assets-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "tag-assets-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="tag-assets-panel" role="dialog" aria-labelledby="tag-assets-title" tabindex="-1">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="tag-assets-title">Tag</h3>' +
          '<button class="btn-icon" id="tag-assets-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="tag-assets-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="tag-assets-body"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeTagAssetsPanel(); });
  document.getElementById("tag-assets-close").addEventListener("click", closeTagAssetsPanel);
  wireSlideoverEscape(overlay, closeTagAssetsPanel);

  var body = document.getElementById("tag-assets-body");
  var openRow = function (row) {
    var assetId = row.getAttribute("data-asset-id");
    if (!assetId) return;
    if (window.PolarisPanels && typeof window.PolarisPanels.openAsset === "function") {
      window.PolarisPanels.openAsset(assetId);
      return;
    }
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
  };
  body.addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (row) openRow(row);
  });
  body.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (row) { e.preventDefault(); openRow(row); }
  });

  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(document.getElementById("tag-assets-panel"), "polaris.panel.width.tagassets");
  }
}

function closeTagAssetsPanel() {
  var overlay = document.getElementById("tag-assets-overlay");
  if (overlay) overlay.classList.remove("open");
  _tagAssetsCurrent = null;
  if (_tagAssetsReturnFocus && typeof _tagAssetsReturnFocus.focus === "function") {
    try { _tagAssetsReturnFocus.focus(); } catch (_) { }
  }
  _tagAssetsReturnFocus = null;
}

function _tagAssetsRow(a) {
  var label = a.hostname || a.ipAddress || a.id;
  var sub = [];
  if (a.ipAddress && a.hostname) sub.push(escapeHtml(a.ipAddress));
  if (a.assetType) sub.push(escapeHtml(a.assetType));
  if (a.status && a.status !== "active") sub.push(escapeHtml(a.status));
  if (a.monitorStatus) sub.push(escapeHtml(a.monitorStatus));
  return '<div data-asset-id="' + escapeHtml(a.id) + '" role="button" tabindex="0" title="Open asset details" ' +
    'style="padding:0.5rem 0.6rem;border:1px solid var(--color-border);border-radius:0.35rem;margin-bottom:0.4rem;cursor:pointer;background:var(--color-surface)">' +
    '<div style="font-weight:500;color:var(--color-accent)">' + escapeHtml(label) + '</div>' +
    (sub.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.1rem">' + sub.join(" · ") + '</div>' : "") +
    '</div>';
}

/**
 * One chip in the Tags card. `canOpenTagAssets` makes it the button that opens
 * the assets-with-this-tag slide-in (GET /assets/by-tag needs assets:read).
 */
function _tagRegistryChipHTML(t, canOpenTagAssets) {
  // .hue-pill (styles.css) draws the chip from `--hue` alone and keeps the
  // label legible whatever colour the operator picked.
  var hueStyle = tagHueStyle(t.color);
  var colorStyle = hueStyle ? ' style="' + hueStyle + '"' : '';
  // Either filter shape counts — a tag written before the condition-tree
  // cutover still auto-assigns through the folded-forward flat blob.
  var managed = !!(t.assetCondition || (t.criteria && t.criteria.rules && t.criteria.rules.length));
  var autoMark = managed
    ? '<span title="Auto-assigned by filter" style="margin-right:4px">&#9881;</span>'
    : '';
  // An `azure:` row is the Arc sync's: read-only here (the server
  // refuses PUT / DELETE), and removed automatically once no asset
  // carries it — so it offers neither verb.
  var mirrored = /^azure:/i.test(t.name);
  var canEdit = isAdmin() && !mirrored;
  var chipTitle = [
    canOpenTagAssets ? "Show the assets with this tag" : "",
    mirrored ? "Mirrored from Azure by the Azure Arc integration — change it in Azure; Polaris removes it once no asset carries it" : "",
  ].filter(Boolean).join(". ");
  return '<span class="tag-chip' + (hueStyle ? ' hue-pill hue-strong' : '') + (canOpenTagAssets ? ' tag-chip-open' : '') + '"' +
      ' data-tag-name="' + escapeHtml(t.name) + '"' +
      (chipTitle ? ' title="' + escapeHtml(chipTitle) + '"' : '') +
      (canOpenTagAssets ? ' role="button" tabindex="0"' : '') +
      colorStyle + '>' +
    autoMark +
    escapeHtml(t.name) +
    (canEdit ? '<button class="tag-chip-edit" data-tag-id="' + t.id + '" title="Edit" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:0.75rem;opacity:0.7;padding:0">&#9998;</button>' : '') +
    (canEdit ? '<button class="tag-chip-delete" data-tag-id="' + t.id + '" title="Delete">&times;</button>' : '') +
  '</span>';
}

async function openTagAssetsPanel(tagName) {
  if (!tagName) return;
  _ensureTagAssetsPanelDOM();
  var overlay = document.getElementById("tag-assets-overlay");
  // A first open records the trigger; a chip clicked while the panel already
  // shows another tag pivots it in place.
  if (!overlay.classList.contains("open")) _tagAssetsReturnFocus = document.activeElement;
  _tagAssetsCurrent = tagName;
  var metaEl = document.getElementById("tag-assets-meta");
  var bodyEl = document.getElementById("tag-assets-body");
  document.getElementById("tag-assets-title").textContent = tagName;
  metaEl.textContent = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';

  raiseSlideover(overlay);
  requestAnimationFrame(function () {
    overlay.classList.add("open");
    var panel = document.getElementById("tag-assets-panel");
    if (panel) panel.focus();
  });

  try {
    var r = await api.assets.byTag(tagName);
    // A late answer for a tag the panel has since left (or closed) is dropped.
    if (_tagAssetsCurrent !== tagName) return;
    var total = r.total || 0;
    var rows = r.assets || [];
    metaEl.innerHTML = '<span>' + total + ' asset' + (total === 1 ? "" : "s") + ' with this tag</span>';
    if (total === 0) {
      bodyEl.innerHTML = '<div style="padding:1rem 1.25rem"><p class="empty-state" style="padding:1rem 0">No assets carry this tag.</p></div>';
      return;
    }
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        (rows.length < total
          ? '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem">Showing the first ' + rows.length + ' of ' + total + '.</p>'
          : '') +
        rows.map(_tagAssetsRow).join("") +
      '</div>';
  } catch (err) {
    if (_tagAssetsCurrent !== tagName) return;
    bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem;color:var(--color-danger)">' +
      escapeHtml(err.message || "Failed to load") + '</p>';
  }
}

// ─── Credential usage slide-in ───────────────────────────────────────────────
// Lists the assets a credential reaches, grouped by the tier each one inherits
// it from (asset / class / integration). Models the canonical asset-details
// slide-over (assets.js): append a `.slideover-overlay` to <body>, toggle the
// `.open` class, reuse initSlideoverResize. Clicking an asset hands off via the
// #view=asset:<id> deep link — assets.js is NOT loaded on this page (see the
// wiring comment below).
var _credUsageReturnFocus = null;

function _ensureCredUsagePanelDOM() {
  if (document.getElementById("cred-usage-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "cred-usage-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="cred-usage-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="cred-usage-title">Credential usage</h3>' +
          '<button class="btn-icon" id="cred-usage-close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="cred-usage-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="cred-usage-body"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeCredUsagePanel(); });
  document.getElementById("cred-usage-close").addEventListener("click", closeCredUsagePanel);
  // Escape only when this panel is topmost — the asset panel a row opens
  // stacks over it (wireSlideoverEscape / isTopmostSlideover, app.js).
  wireSlideoverEscape(overlay, closeCredUsagePanel);

  // Click-through to asset details, in place over this panel: PolarisPanels
  // (app.js) loads assets.js on demand on the Server Settings page. The
  // canonical #view=asset:<id> deep link, which processSearchHash() opens on
  // load, stays as the fallback.
  document.getElementById("cred-usage-body").addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (!row) return;
    var assetId = row.getAttribute("data-asset-id");
    if (!assetId) return;
    if (window.PolarisPanels && typeof window.PolarisPanels.openAsset === "function") {
      window.PolarisPanels.openAsset(assetId);
      return;
    }
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
  });

  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(document.getElementById("cred-usage-panel"), "polaris.panel.width.credusage");
  }
}

function closeCredUsagePanel() {
  var overlay = document.getElementById("cred-usage-overlay");
  if (overlay) overlay.classList.remove("open");
  if (_credUsageReturnFocus && typeof _credUsageReturnFocus.focus === "function") {
    try { _credUsageReturnFocus.focus(); } catch (_) { }
  }
  _credUsageReturnFocus = null;
}

function _credStreamBadges(streams) {
  if (!streams || !streams.length) return "";
  return streams.map(function (s) {
    return '<span style="display:inline-block;font-size:0.68rem;padding:0.05rem 0.4rem;border-radius:0.25rem;' +
      'background:var(--color-bg-tertiary);color:var(--color-text-secondary);margin:0 0.15rem 0.15rem 0;white-space:nowrap">' +
      escapeHtml(s) + '</span>';
  }).join("");
}

function _credUsageAssetRow(a) {
  var label = a.hostname || a.ipAddress || a.assetId;
  var sub = [];
  if (a.ipAddress && a.hostname) sub.push(escapeHtml(a.ipAddress));
  if (a.assetType) sub.push(escapeHtml(a.assetType));
  if (!a.monitored) sub.push('<span style="color:var(--color-text-tertiary)">not monitored</span>');
  return '<div data-asset-id="' + escapeHtml(a.assetId) + '" role="button" tabindex="0" ' +
    'title="Open asset details" ' +
    'style="padding:0.5rem 0.6rem;border:1px solid var(--color-border);border-radius:0.35rem;margin-bottom:0.4rem;cursor:pointer;background:var(--color-surface)">' +
    '<div style="font-weight:500;color:var(--color-accent)">' + escapeHtml(label) + '</div>' +
    (sub.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.1rem">' + sub.join(" · ") + '</div>' : "") +
    (a.streams && a.streams.length ? '<div style="margin-top:0.3rem">' + _credStreamBadges(a.streams) + '</div>' : "") +
    '</div>';
}

function _credUsageSectionHeader(title, count, blurb) {
  return '<div style="margin:1rem 0 0.5rem">' +
    '<h4 style="margin:0 0 0.15rem">' + escapeHtml(title) + ' (' + count + ')</h4>' +
    (blurb ? '<p style="margin:0;font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(blurb) + '</p>' : "") +
    '</div>';
}

async function openCredUsagePanel(credId, credName) {
  _ensureCredUsagePanelDOM();
  _credUsageReturnFocus = document.activeElement;
  var titleEl = document.getElementById("cred-usage-title");
  var metaEl = document.getElementById("cred-usage-meta");
  var bodyEl = document.getElementById("cred-usage-body");
  titleEl.textContent = credName ? credName : "Credential usage";
  metaEl.textContent = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';

  raiseSlideover(document.getElementById("cred-usage-overlay"));
  requestAnimationFrame(function () {
    var ov = document.getElementById("cred-usage-overlay");
    ov.classList.add("open");
    var panel = document.getElementById("cred-usage-panel");
    if (panel) panel.focus();
  });

  try {
    var u = await api.credentials.usage(credId);
    var total = u.total || 0;
    metaEl.innerHTML =
      '<span>' + total + ' asset' + (total === 1 ? "" : "s") + ' use this credential</span>';

    if (total === 0 && !u.classRefCount && !u.integrationRefCount) {
      bodyEl.innerHTML =
        '<div style="padding:1rem 1.25rem">' +
          '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
            'This shows where the credential is configured across the monitor-settings tiers and agent installs — not a live probe trace.' +
          '</p>' +
          '<p class="empty-state" style="padding:1rem 0">No assets use this credential, and it is not referenced by any class or integration setting.</p>' +
        '</div>';
      return;
    }

    var html =
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0.5rem 0 0.25rem">' +
        'Assets are grouped by the tier they inherit this credential from. Click any asset to open its details.' +
      '</p>';

    // Asset level
    if (u.assetLevel && u.assetLevel.length) {
      html += _credUsageSectionHeader("Asset level", u.assetLevel.length, "Configured directly on the asset.");
      html += u.assetLevel.map(_credUsageAssetRow).join("");
    }

    // Class level
    if (u.classLevel && u.classLevel.length) {
      var classCount = u.classLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Class level", classCount, "Inherited from a per-class monitor override (integration + asset type).");
      html += u.classLevel.map(function (g) {
        var scope = (g.integrationName || "Manual tier") + " · " + g.assetType;
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(scope) +
            (g.streams && g.streams.length ? ' <span style="font-weight:400;color:var(--color-text-secondary)">— ' + g.streams.map(escapeHtml).join(", ") + '</span>' : "") +
          '</div>' +
          g.assets.map(_credUsageAssetRow).join("") +
          '</div>';
      }).join("");
    }

    // Integration level
    if (u.integrationLevel && u.integrationLevel.length) {
      var intCount = u.integrationLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Integration level", intCount, "Inherited from the integration's default monitor credential.");
      html += u.integrationLevel.map(function (g) {
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(g.integrationName) + '</div>' +
          g.assets.map(_credUsageAssetRow).join("") +
          '</div>';
      }).join("");
    }

    // Operations — reboots and Polaris Agent install / upgrade / reboot opt-in.
    if (u.operationLevel && u.operationLevel.length) {
      var opCount = u.operationLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Operations", opCount, "Used to act on the asset rather than poll it — reboots and agent installs. An asset can also appear under a monitoring tier above.");
      html += u.operationLevel.map(function (g) {
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(g.label) + '</div>' +
          g.assets.map(_credUsageAssetRow).join("") +
          '</div>';
      }).join("");
    }

    // Config references with no current assets (e.g. a class/integration default
    // pointing here but no asset matches the class yet).
    if (total === 0 && (u.classRefCount || u.integrationRefCount)) {
      var refs = [];
      if (u.classRefCount) refs.push(u.classRefCount + " class override" + (u.classRefCount === 1 ? "" : "s"));
      if (u.integrationRefCount) refs.push(u.integrationRefCount + " integration default" + (u.integrationRefCount === 1 ? "" : "s"));
      html += '<p class="empty-state" style="padding:1rem 0">No assets currently resolve to this credential, but it is referenced by ' +
        refs.join(" and ") + '.</p>';
    }

    bodyEl.innerHTML = '<div style="padding:0.75rem 1.25rem 1.25rem">' + html + '</div>';
  } catch (err) {
    bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// Launches the Test Connection modal directly from the credentials list,
// without going through the edit modal first. Secrets in the GET payload are
// masked, but the server's /credentials/test endpoint merges real values back
// in via `id`, so the probe sees the actual stored secrets.
async function testCredentialFromList(id) {
  var cred;
  try { cred = await api.credentials.get(id); }
  catch (err) { showToast(err.message, "error"); return; }
  openCredentialTestModal({
    id: cred.id,
    name: cred.name,
    type: cred.type,
    config: cred.config,
    fromList: true,
  });
}

async function openCredentialModal(id, initialState) {
  var cred = null;
  if (id) {
    try { cred = await api.credentials.get(id); }
    catch (err) { showToast(err.message, "error"); return; }
  }
  var isNew = !cred;
  // initialState overrides the fetched-or-default form values; passed by the
  // Test Connection modal's Back button so the operator's in-flight edits
  // (including a freshly-typed password) survive the round-trip.
  var formName   = initialState ? initialState.name   : (cred ? cred.name   : "");
  var formType   = initialState ? initialState.type   : (cred ? cred.type   : "snmp");
  var formConfig = initialState ? initialState.config : (cred ? cred.config : null);
  var title = isNew ? "Add Credential" : ("Edit Credential — " + (cred ? cred.name : ""));
  var body =
    '<div class="form-group"><label>Name</label>' +
      '<input type="text" id="f-cred-name" value="' + escapeHtml(formName) + '" placeholder="e.g. Core SNMP v2c">' +
    '</div>' +
    '<div class="form-group"><label>Type</label>' +
      '<select id="f-cred-type"' + (isNew ? '' : ' disabled') + '>' +
        '<option value="snmp"'    + (formType === "snmp"    ? ' selected' : '') + '>SNMP</option>' +
        '<option value="winrm"'   + (formType === "winrm"   ? ' selected' : '') + '>WinRM</option>' +
        '<option value="ssh"'     + (formType === "ssh"     ? ' selected' : '') + '>SSH</option>' +
        '<option value="restapi"' + (formType === "restapi" ? ' selected' : '') + '>REST API</option>' +
        '<option value="http"'    + (formType === "http"    ? ' selected' : '') + '>HTTP</option>' +
      '</select>' +
      (isNew ? '<p class="hint">Type cannot be changed after creation.</p>' : '') +
    '</div>' +
    '<div id="cred-type-fields"></div>';
  var footer =
    '<button class="btn btn-secondary" id="btn-cred-test" style="margin-right:auto">Test Connection</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-cred-save">Save</button>';
  openModal(title, body, footer);

  function renderTypeFields() {
    var t = document.getElementById("f-cred-type").value;
    // New credentials default to verify-ON (2026-06-03 review, H1). SSH
    // host-key pinning is ON for every credential unless it stores
    // verifyHostKey: false (business rule 113), so its box reads checked for
    // an existing credential with no flag. initialState (Back button) always
    // wins so in-flight edits survive.
    var cfg = formConfig || (isNew ? { verifyTls: true, verifyHostKey: true } : {});
    var host = document.getElementById("cred-type-fields");
    if (t === "snmp")        host.innerHTML = credSnmpForm(cfg);
    else if (t === "winrm")  host.innerHTML = credWinrmForm(cfg);
    else if (t === "ssh")    host.innerHTML = credSshForm(cfg);
    else if (t === "restapi") host.innerHTML = credRestApiForm(cfg);
    else if (t === "http")    host.innerHTML = credHttpForm(cfg);
    if (t === "snmp") wireSnmpVersionToggle();
    if (t === "http") wireHttpAuthModeToggle();
  }
  document.getElementById("f-cred-type").addEventListener("change", function () {
    // Switching type discards the config from the old type — there's no
    // sensible cross-type carryover (SNMP community vs WinRM password etc.)
    formConfig = null;
    renderTypeFields();
  });
  renderTypeFields();

  document.getElementById("btn-cred-test").addEventListener("click", function () {
    var name = (document.getElementById("f-cred-name").value || "").trim();
    var selectedType = document.getElementById("f-cred-type").value;
    var config = readCredentialForm(selectedType);
    openCredentialTestModal({
      id: id,
      name: name,
      type: selectedType,
      config: config,
    });
  });

  document.getElementById("btn-cred-save").addEventListener("click", async function () {
    var name = (document.getElementById("f-cred-name").value || "").trim();
    if (!name) { showToast("Name is required", "error"); return; }
    var selectedType = document.getElementById("f-cred-type").value;
    var config = readCredentialForm(selectedType);
    try {
      if (isNew) await api.credentials.create({ name: name, type: selectedType, config: config });
      else await api.credentials.update(id, { name: name, config: config });
      closeModal();
      showToast("Credential saved");
      await loadCredentialsTab();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

// Test Connection modal — opens on top of the credential edit modal. Operator
// searches for an asset by name/IP/hostname; the asset's IP supplies the host
// for a one-shot probe of the credential as it currently sits in the form.
// Back returns to the credential modal with the operator's in-flight edits
// preserved (including any freshly-typed password) so the test result can
// inform their next save.
/**
 * The response an HTTP check actually got back, rendered so the operator can
 * TAILOR the check against it. This is the whole reason the test
 * flow exists for this type: an HTTP check's expectation is a string that has to
 * be picked OUT of the device's response, and pass/fail gives you nothing to
 * pick from. The body is shown verbatim (escaped) in a selectable block.
 *
 * The match verdict is stated separately from the pass/fail above it because it
 * is THREE-valued: matched, not matched, or nothing configured to match. The
 * last is the state every operator is in on their first test, and collapsing it
 * into the pass/fail line would read as a failed match and send them hunting
 * for a problem with the device instead of typing an expectation.
 */
function credHttpDiagnosticsHTML(diag, cfg, check) {
  if (!diag) return "";
  var muted = "color:var(--color-text-secondary)";
  function row(label, value) {
    return '<div style="display:flex;gap:0.5rem;font-size:0.8rem;margin-top:0.15rem">' +
      '<span style="' + muted + ';min-width:104px;flex-shrink:0">' + escapeHtml(label) + '</span>' +
      '<span style="word-break:break-all">' + escapeHtml(String(value)) + '</span>' +
    '</div>';
  }

  // Match verdict. null = nothing configured yet, which is the state an operator
  // is in on the first test — say so and point at the next step instead of
  // rendering a neutral dash they have to interpret.
  var verdict;
  if (diag.matched === null || diag.matched === undefined) {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;' + muted + '">' +
      'No expected content set — judged on the status code alone. Pick a distinctive string out of the body below and paste it into <strong>Expected content</strong>.' +
    '</div>';
  } else if (diag.matched === true) {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;color:var(--color-success,#27ae60)">' +
      '✓ Expected content found in the response body.' +
    '</div>';
  } else {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;color:var(--color-warning,#d68910)">' +
      '⚠ Expected content NOT found in the response body — the check fails.' +
    '</div>';
  }

  var size = diag.bytesRead + ' bytes' +
    (diag.bodyTruncatedAtCap ? ' (device sent more — read capped)' : '');

  // What the device ASKED for. A 401 is otherwise indistinguishable between
  // "wrong password" and "you configured Basic and it wants Digest" — and the
  // second is the common case on cameras and other embedded devices.
  var authRow = "";
  if (diag.authRequested && diag.authRequested.length) {
    var selected = httpAuthModeOf(cfg || {});
    var offered = diag.authRequested.join(", ");
    var mismatch = diag.statusCode === 401 &&
      selected !== "none" &&
      diag.authRequested.map(function (s) { return String(s).toLowerCase(); }).indexOf(selected) === -1;
    authRow = row("Device requested", offered +
      (mismatch
        ? ' — this credential is set to "' + selected + '". Switch Authentication to match.'
        : ''));
  }
  if (diag.digestNegotiated) {
    authRow += row("Digest", "challenge answered, request re-sent");
  }

  return '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--color-border);border-radius:4px">' +
      '<div style="font-weight:600;font-size:0.85rem">Response</div>' +
      row("Requested", diag.url) +
      row("Status", diag.statusCode) +
      authRow +
      (diag.contentType ? row("Content-Type", diag.contentType) : "") +
      row("Body size", size) +
      verdict +
      '<div style="font-size:0.78rem;' + muted + ';margin-top:0.6rem">Body' +
        (diag.excerptTruncated ? ' (first ' + diag.excerpt.length + ' characters)' : '') +
      '</div>' +
      '<pre style="margin:0.2rem 0 0;padding:0.5rem;max-height:260px;overflow:auto;background:var(--color-surface-alt,rgba(127,127,127,0.08));border-radius:3px;font-size:0.78rem;white-space:pre-wrap;word-break:break-word;user-select:text">' +
        (diag.excerpt ? escapeHtml(diag.excerpt) : '<span style="' + muted + '">(empty body)</span>') +
      '</pre>' +
    '</div>';
}

/**
 * The CHECK-definition fields, rendered inside the Test Connection modal for
 * `http` credentials.
 *
 * These used to live on the credential form. They moved to the manufacturer
 * custom widget that owns the check — but the test flow still needs them,
 * because tailoring a check is inherently iterative: you cannot know which
 * string to expect until you have seen what the device returns. So the modal
 * carries a full, unsaved check definition, and the loop is: point it at a
 * device, read the body that comes back, paste a distinctive string into
 * Expected content, re-test — then save the settled values onto the widget.
 *
 * Nothing here is persisted by the test.
 */
function credHttpCheckFields() {
  return '' +
    '<div style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      '<div style="font-weight:600;font-size:0.85rem;margin-bottom:0.5rem">Check to run</div>' +
      '<p class="hint" style="margin-top:0">These describe the request, not the credential. Once they are right, save them on the matching <strong>Manufacturer Profile → Custom Widget</strong>; this modal never persists them.</p>' +
      '<div class="form-group" style="margin-top:1rem">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-https">' +
          '<span>Use HTTPS</span>' +
        '</label>' +
      '</div>' +
      // Port is an opt-in override: the scheme already implies one (80 / 443),
      // so an always-editable box invites typing the value that was already
      // going to be used. Disabled rather than hidden so it is visible that a
      // port exists and is being defaulted.
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-customport">' +
          '<span>Custom port</span>' +
        '</label>' +
        '<input type="number" id="f-tchk-port" min="1" max="65535" placeholder="default (80)" style="max-width:200px;margin-top:4px" disabled>' +
      '</div>' +
      '<div class="form-group"><label>Path</label>' +
        '<input type="text" id="f-tchk-path" placeholder="/healthz">' +
      '</div>' +
      '<div class="form-group"><label>Expected status code</label>' +
        '<input type="number" id="f-tchk-status" min="100" max="599" placeholder="any 2xx" style="max-width:200px">' +
        '<p class="hint">Leave blank to accept any 2xx. Redirects are never followed, so set this to 301/302 only if the redirect itself is the healthy answer.</p>' +
      '</div>' +
      '<div class="form-group"><label>Match</label>' +
        // flex-wrap so the checkbox drops below the select on a narrow modal
        // rather than being clipped out of reach.
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
          '<select id="f-tchk-matchmode" style="max-width:240px">' +
            '<option value="contains" selected>Contains this text</option>' +
            '<option value="regex">Matches this regular expression</option>' +
          '</select>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">' +
            '<input type="checkbox" id="f-tchk-casesensitive">' +
            '<span>Case sensitive</span>' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Expected content</label>' +
        '<input type="text" id="f-tchk-body" placeholder="e.g. OK">' +
        '<p class="hint">Text the response body must carry. This is what separates "the web server answered" from "the service still works" — a device serving an error page still returns 200. Leave blank to judge on the status code alone.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-verifytls">' +
          '<span>Verify TLS certificate</span>' +
        '</label>' +
        '<p class="hint">Only applies with HTTPS. Off by default — device management certs are usually self-signed.</p>' +
      '</div>' +
    '</div>';
}

/** Collect the modal's check definition. Blank number fields mean "default". */
function readHttpCheckFields() {
  function numOrNull(id) {
    var v = (document.getElementById(id).value || "").trim();
    return v ? Number(v) : null;
  }
  // A disabled Custom port sends null rather than whatever is left in the box,
  // so un-ticking it actually returns the check to the scheme default instead
  // of silently keeping the last typed value.
  var customPort = document.getElementById("f-tchk-customport").checked;
  return {
    useHttps:       document.getElementById("f-tchk-https").checked,
    port:           customPort ? numOrNull("f-tchk-port") : null,
    path:           (document.getElementById("f-tchk-path").value || "").trim(),
    expectStatus:   numOrNull("f-tchk-status"),
    expectBody:     document.getElementById("f-tchk-body").value,
    matchMode:      document.getElementById("f-tchk-matchmode").value,
    caseSensitive:  document.getElementById("f-tchk-casesensitive").checked,
    verifyTls:      document.getElementById("f-tchk-verifytls").checked,
  };
}

function openCredentialTestModal(state) {
  var typeLabel = credTypeLabel(state.type);
  var title = "Test Credential" + (state.name ? " — " + state.name : "");
  var body =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
      // Charon: no Asset inventory, so the "Choose an existing asset" mode is
      // left out and the typed-host mode is the only (pre-selected) target.
      'Type the address to test this ' + escapeHtml(typeLabel) + ' credential against. ' +
      'Only the host is used; the form values you entered are what gets exercised.' +
      (state.type === 'http'
        ? ' The response body comes back below, so you can pick your <strong>Expected content</strong> string out of what the device actually returns.'
        : '') +
    '</p>' +
    '<div class="form-group" style="display:none">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;margin-top:0.25rem">' +
        '<input type="radio" name="cred-test-mode" value="manual" checked>' +
        '<span>Enter an IP or hostname</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group" data-test-mode="asset" style="display:none"><label>Search asset</label>' +
      '<input type="search" id="f-cred-test-search" autocomplete="off" spellcheck="false" placeholder="hostname, IP, or MAC (min 2 chars)">' +
      '<div id="f-cred-test-results" style="margin-top:0.25rem;max-height:240px;overflow:auto;border:1px solid var(--color-border);border-radius:4px;display:none"></div>' +
    '</div>' +
    '<div id="f-cred-test-selected" data-test-mode="asset" style="display:none;padding:0.6rem 0.75rem;border:1px solid var(--color-border);border-radius:4px;margin-bottom:0.75rem;background:var(--color-surface-alt,rgba(127,127,127,0.05))"></div>' +
    '<div class="form-group" data-test-mode="manual"><label>IP address or hostname</label>' +
      '<input type="text" id="f-cred-test-host" autocomplete="off" spellcheck="false" placeholder="10.20.30.40">' +
      '<p class="hint">Just the host — no scheme, port or path. Those are part of the check below, so a pasted URL is refused rather than silently trimmed down to something that dials differently from what you typed. Nothing is saved; this only picks the target for one probe.</p>' +
    '</div>' +
    (state.type === 'http' ? credHttpCheckFields() : '') +
    '<div id="f-cred-test-result" style="display:none"></div>';
  var footer =
    (state.fromList ? '' : '<button class="btn btn-secondary" id="btn-cred-test-back" style="margin-right:auto">&larr; Back</button>') +
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>' +
    '<button class="btn btn-primary" id="btn-cred-test-run" disabled>Run Test</button>';
  openModal(title, body, footer);

  var selectedAsset = null;
  var searchTimer = null;
  var lastQuery = "";

  var searchInput   = document.getElementById("f-cred-test-search");
  var resultsBox    = document.getElementById("f-cred-test-results");
  var selectedBox   = document.getElementById("f-cred-test-selected");
  var hostInput     = document.getElementById("f-cred-test-host");
  var resultBox     = document.getElementById("f-cred-test-result");
  var runBtn        = document.getElementById("btn-cred-test-run");
  var backBtn       = document.getElementById("btn-cred-test-back");
  var modeRadios    = document.querySelectorAll('input[name="cred-test-mode"]');

  function testMode() {
    for (var i = 0; i < modeRadios.length; i++) {
      if (modeRadios[i].checked) return modeRadios[i].value;
    }
    return "asset";
  }

  /**
   * Run Test is enabled by whichever half the current mode actually uses, so
   * switching modes can't leave it enabled on the strength of the other half's
   * input — which would post an assetId the operator had already navigated away
   * from.
   */
  function syncRunEnabled() {
    runBtn.disabled = testMode() === "asset"
      ? !selectedAsset
      : !(hostInput.value || "").trim();
  }

  for (var mi = 0; mi < modeRadios.length; mi++) {
    modeRadios[mi].addEventListener("change", function () {
      var mode = testMode();
      var groups = document.querySelectorAll("[data-test-mode]");
      for (var i = 0; i < groups.length; i++) {
        var forMode = groups[i].getAttribute("data-test-mode");
        // The selected-asset card is only ever shown when something is selected,
        // so restoring it on a mode flip has to respect that too.
        var wanted = forMode === mode && (groups[i].id !== "f-cred-test-selected" || !!selectedAsset);
        groups[i].style.display = wanted ? "" : "none";
      }
      syncRunEnabled();
      var focusEl = mode === "asset" ? searchInput : hostInput;
      setTimeout(function () { focusEl.focus(); }, 0);
    });
  }
  // Port controls (http only): Custom port gates the field, and Use HTTPS
  // relabels its placeholder so the default on offer is the real one.
  var httpsBox  = document.getElementById("f-tchk-https");
  var customBox = document.getElementById("f-tchk-customport");
  var portInput = document.getElementById("f-tchk-port");
  if (httpsBox && customBox && portInput) {
    function syncPort() {
      portInput.disabled = !customBox.checked;
      portInput.placeholder = "default (" + (httpsBox.checked ? "443" : "80") + ")";
      portInput.style.opacity = customBox.checked ? "" : "0.5";
    }
    httpsBox.addEventListener("change", syncPort);
    customBox.addEventListener("change", syncPort);
    syncPort();
  }

  hostInput.addEventListener("input", syncRunEnabled);
  hostInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !runBtn.disabled) { e.preventDefault(); runBtn.click(); }
  });

  function setSelected(hit) {
    selectedAsset = hit;
    if (!hit) {
      selectedBox.style.display = "none";
      syncRunEnabled();
      return;
    }
    selectedBox.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:0.6rem">' +
        '<div style="color:var(--color-success,#27ae60);font-weight:700;font-size:1.1rem;line-height:1.2;flex-shrink:0" aria-label="Selected">✓</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">' + escapeHtml(hit.title || "asset") + '</div>' +
          (hit.subtitle ? '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(hit.subtitle) + '</div>' : '') +
        '</div>' +
      '</div>';
    selectedBox.style.display = "block";
    resultsBox.style.display = "none";
    resultsBox.innerHTML = "";
    searchInput.value = hit.title || "";
    syncRunEnabled();
  }

  function renderResults(hits) {
    if (!hits.length) {
      resultsBox.innerHTML = '<div style="padding:0.5rem 0.75rem;color:var(--color-text-secondary);font-size:0.85rem">No asset matches.</div>';
      resultsBox.style.display = "block";
      return;
    }
    resultsBox.innerHTML = hits.map(function (h, idx) {
      return '<div class="cred-test-hit" data-idx="' + idx + '" style="padding:0.5rem 0.75rem;cursor:pointer;border-bottom:1px solid var(--color-border)">' +
        '<div style="font-weight:600">' + escapeHtml(h.title || "asset") + '</div>' +
        (h.subtitle ? '<div style="font-size:0.8rem;color:var(--color-text-secondary)">' + escapeHtml(h.subtitle) + '</div>' : '') +
      '</div>';
    }).join("");
    resultsBox.style.display = "block";
    resultsBox.querySelectorAll(".cred-test-hit").forEach(function (el) {
      el.addEventListener("click", function () {
        var idx = Number(el.getAttribute("data-idx"));
        setSelected(hits[idx]);
      });
    });
  }

  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim();
    if (selectedAsset && q !== (selectedAsset.title || "")) {
      // operator started typing again — clear the previous selection
      selectedAsset = null;
      selectedBox.style.display = "none";
      syncRunEnabled();
    }
    clearTimeout(searchTimer);
    if (q.length < 2) {
      resultsBox.style.display = "none";
      resultsBox.innerHTML = "";
      lastQuery = "";
      return;
    }
    searchTimer = setTimeout(async function () {
      lastQuery = q;
      try {
        // /assets, not the global /search endpoint: /search caps each
        // entity group at 8 and partitions pinned firewalls out into
        // `sites`, so on fleets with lots of endpoints sharing a hostname
        // prefix a firewall could silently fall off the bottom of the
        // typeahead. /assets has no per-group cap and returns every
        // asset type uniformly, including firewalls regardless of map pin.
        var results = await api.assets.list({ search: q, limit: 25 });
        if (q !== lastQuery) return; // stale
        var hits = (results.assets || []).map(function (a) {
          var vendorModel = [a.manufacturer, a.model].filter(Boolean).join(" ");
          var bits = [a.ipAddress, a.macAddress, vendorModel].filter(Boolean);
          return {
            id: a.id,
            title: a.hostname || a.assetTag || "asset",
            subtitle: bits.join(" — ") || a.assetType,
          };
        });
        renderResults(hits);
      } catch (err) {
        resultsBox.innerHTML = '<div style="padding:0.5rem 0.75rem;color:var(--color-danger,#c0392b);font-size:0.85rem">Search failed: ' + escapeHtml(err.message || "Unknown error") + '</div>';
        resultsBox.style.display = "block";
      }
    }, 180);
  });
  setTimeout(function () { hostInput.focus(); }, 0); // Charon: typed host is the only mode

  runBtn.addEventListener("click", async function () {
    var mode = testMode();
    var typedHost = (hostInput.value || "").trim();
    if (mode === "asset" ? !selectedAsset : !typedHost) return;
    runBtn.disabled = true;
    var origLabel = runBtn.textContent;
    runBtn.textContent = "Testing…";
    resultBox.style.display = "block";
    resultBox.innerHTML = '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.75rem 0 0">Running probe…</p>';
    // Send exactly ONE target. The server prefers assetId when both arrive, but
    // sending only what the current mode selected keeps the audited hostSource
    // honest about what the operator actually aimed at.
    var body = { type: state.type, config: state.config };
    if (mode === "asset") body.assetId = selectedAsset.id;
    else body.host = typedHost;
    if (state.id) body.id = state.id;
    // The check definition is per-test, not part of the credential.
    if (state.type === "http") body.check = readHttpCheckFields();
    try {
      var res = await api.credentials.test(body);
      var ok = !!res.success;
      var color = ok ? 'var(--color-success,#27ae60)' : 'var(--color-danger,#c0392b)';
      var icon  = ok ? '✓' : '✗';
      var label = ok ? 'Success' : 'Failed';
      var detail;
      if (ok) detail = 'Probe answered in ' + (res.responseTimeMs || 0) + ' ms.';
      else detail = res.error || 'Probe failed (no error returned).';
      resultBox.innerHTML =
        '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid ' + color + ';border-radius:4px;background:rgba(127,127,127,0.04)">' +
          '<div style="font-weight:600;color:' + color + '">' + icon + ' ' + label + '</div>' +
          '<div style="font-size:0.85rem;margin-top:0.25rem">' + escapeHtml(detail) + '</div>' +
          (res.host ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.25rem">Host: ' + escapeHtml(res.host) + '</div>' : '') +
        '</div>' +
        credHttpDiagnosticsHTML(res.httpDiagnostics, state.config, body.check);
    } catch (err) {
      resultBox.innerHTML =
        '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--color-danger,#c0392b);border-radius:4px">' +
          '<div style="font-weight:600;color:var(--color-danger,#c0392b)">✗ Failed</div>' +
          '<div style="font-size:0.85rem;margin-top:0.25rem">' + escapeHtml(err.message || "Test request failed") + '</div>' +
        '</div>';
    } finally {
      runBtn.textContent = origLabel;
      syncRunEnabled();
    }
  });

  if (backBtn) {
    backBtn.addEventListener("click", function () {
      openCredentialModal(state.id, { name: state.name, type: state.type, config: state.config });
    });
  }
}

function credSnmpForm(cfg) {
  var version = cfg.version === "v3" ? "v3" : "v2c";
  var community = cfg.community || "";
  var port = cfg.port || "";
  var v3 = {
    username: cfg.username || "",
    securityLevel: cfg.securityLevel || "authPriv",
    authProtocol: cfg.authProtocol || "SHA",
    authKey: cfg.authKey || "",
    privProtocol: cfg.privProtocol || "AES",
    privKey: cfg.privKey || "",
  };
  return (
    '<div class="form-group"><label>Version</label>' +
      '<select id="f-snmp-version">' +
        '<option value="v2c"' + (version === "v2c" ? " selected" : "") + '>v2c</option>' +
        '<option value="v3"'  + (version === "v3"  ? " selected" : "") + '>v3</option>' +
      '</select>' +
    '</div>' +
    '<div id="snmp-v2c-fields" style="display:' + (version === "v2c" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Community</label>' +
        '<input type="password" id="f-snmp-community" value="' + escapeHtml(community) + '" placeholder="public">' +
      '</div>' +
    '</div>' +
    '<div id="snmp-v3-fields" style="display:' + (version === "v3" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Username</label>' +
        '<input type="text" id="f-snmp-user" value="' + escapeHtml(v3.username) + '">' +
      '</div>' +
      '<div class="form-group"><label>Security Level</label>' +
        '<select id="f-snmp-seclevel">' +
          '<option value="noAuthNoPriv"' + (v3.securityLevel === "noAuthNoPriv" ? " selected" : "") + '>noAuthNoPriv</option>' +
          '<option value="authNoPriv"'   + (v3.securityLevel === "authNoPriv"   ? " selected" : "") + '>authNoPriv</option>' +
          '<option value="authPriv"'     + (v3.securityLevel === "authPriv"     ? " selected" : "") + '>authPriv</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Protocol</label>' +
        '<select id="f-snmp-authproto">' +
          '<option value="SHA"'    + (v3.authProtocol === "SHA"    ? " selected" : "") + '>SHA-1 (HMAC-SHA-96)</option>' +
          '<option value="MD5"'    + (v3.authProtocol === "MD5"    ? " selected" : "") + '>MD5 (HMAC-MD5-96)</option>' +
          '<option value="SHA224"' + (v3.authProtocol === "SHA224" ? " selected" : "") + '>SHA-224</option>' +
          '<option value="SHA256"' + (v3.authProtocol === "SHA256" ? " selected" : "") + '>SHA-256</option>' +
          '<option value="SHA384"' + (v3.authProtocol === "SHA384" ? " selected" : "") + '>SHA-384</option>' +
          '<option value="SHA512"' + (v3.authProtocol === "SHA512" ? " selected" : "") + '>SHA-512</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Key</label>' +
        '<input type="password" id="f-snmp-authkey" value="' + escapeHtml(v3.authKey) + '">' +
      '</div>' +
      '<div class="form-group"><label>Priv Protocol</label>' +
        '<select id="f-snmp-privproto">' +
          '<option value="AES"'     + (v3.privProtocol === "AES"     ? " selected" : "") + '>AES-128 (CFB)</option>' +
          '<option value="DES"'     + (v3.privProtocol === "DES"     ? " selected" : "") + '>DES (CBC, 56-bit)</option>' +
          '<option value="AES256B"' + (v3.privProtocol === "AES256B" ? " selected" : "") + '>AES-256 (Blumenthal draft)</option>' +
          '<option value="AES256R"' + (v3.privProtocol === "AES256R" ? " selected" : "") + '>AES-256 (Reeder draft / Cisco)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Priv Key</label>' +
        '<input type="password" id="f-snmp-privkey" value="' + escapeHtml(v3.privKey) + '">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-snmp-port" value="' + escapeHtml(String(port)) + '" placeholder="161" min="1" max="65535">' +
    '</div>'
  );
}

function wireSnmpVersionToggle() {
  var sel = document.getElementById("f-snmp-version");
  if (!sel) return;
  sel.addEventListener("change", function () {
    var v = sel.value;
    var v2 = document.getElementById("snmp-v2c-fields");
    var v3 = document.getElementById("snmp-v3-fields");
    if (v2) v2.style.display = v === "v2c" ? "block" : "none";
    if (v3) v3.style.display = v === "v3"  ? "block" : "none";
  });
}

function credWinrmForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-winrm-user" value="' + escapeHtml(cfg.username || "") + '" placeholder="Administrator">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-winrm-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-winrm-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="5986" min="1" max="65535">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-winrm-https"' + (cfg.useHttps ? " checked" : "") + '>' +
        '<span>Use HTTPS</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-winrm-verifytls"' + (cfg.verifyTls === true ? " checked" : "") + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
      '<p class="hint">Applies when Use HTTPS is on. WinRM sends the username and password as Basic auth. When checked, the certificate must chain to a trusted CA. When unchecked (a self-signed listener), Charon pins the certificate it sees on the first connection and refuses to send the password if it ever changes; when a certificate is legitimately re-issued, the refusal is logged on the Events page with the setting to clear to trust the new one.</p>' +
    '</div>'
  );
}

function credSshForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-ssh-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-ssh-pass" value="' + escapeHtml(cfg.password || "") + '">' +
      '<p class="hint">Provide either a password or a private key.</p>' +
    '</div>' +
    '<div class="form-group"><label>Private Key</label>' +
      '<textarea id="f-ssh-key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">' + escapeHtml(cfg.privateKey || "") + '</textarea>' +
    '</div>' +
    '<div class="form-group"><label>Private Key Passphrase <span style="font-weight:normal;color:var(--color-text-tertiary)">(only if the key is encrypted)</span></label>' +
      '<input type="password" id="f-ssh-passphrase" value="' + escapeHtml(cfg.passphrase || "") + '" autocomplete="new-password">' +
      // Charon: polaris's note about its generated SSH-deployment keys dropped (no such feature here).
      '<p class="hint">Leave blank for an unencrypted key.</p>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-ssh-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="22" min="1" max="65535">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-ssh-verifyhostkey"' + (cfg.verifyHostKey !== false ? " checked" : "") + '>' +
        '<span>Verify the server\'s host key</span>' +
      '</label>' +
      '<p class="hint">Recommended. When off, Charon accepts whatever host key is presented, so anything answering on the target\'s address can impersonate it and receive this login. On first connection Charon pins the key it sees and refuses later connections if it changes; if a host is legitimately rebuilt or re-keyed, the refusal is logged on the Events page with the setting to clear to trust the new key.</p>' +
    '</div>' +
    credAllowRebootHTML(cfg,
      "Lets this login run <code>execute reboot</code> on a FortiGate it is set on, restart the FortiSwitches and FortiAPs that FortiGate manages, or reboot a standalone FortiSwitch / FortiAP over its own CLI.")
  );
}

/**
 * The "Allow reboots" opt-in (business rule 115) — one box shared by the two
 * credential kinds that can reboot a FortiGate / FortiSwitch / FortiAP: SSH
 * and REST API token. Off by default; the server refuses it on any other kind
 * and records every flip on the credential's Event.
 */
function credAllowRebootHTML(cfg, what) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-cred-allowreboot"' + (cfg.allowReboot === true ? " checked" : "") + '>' +
      '<span>Allow reboots</span>' +
    '</label>' +
    '<p class="hint">Off by default. ' + what + ' Anyone with Read-Write on Assets can then reboot those devices from the asset’s <strong>Reboot</strong> button, now or on a schedule; FortiGate HA members are always refused. ' +
      'The admin behind the credential also needs System read-write on the device.</p>' +
  '</div>';
}

function credRestApiForm(cfg) {
  return (
    '<div class="form-group"><label>Base URL</label>' +
      '<input type="text" id="f-rest-baseurl" value="' + escapeHtml(cfg.baseUrl || "") + '" placeholder="https://device.example/">' +
      '<p class="hint">Full URL the credential authenticates against, including scheme. Trailing slashes are normalized. ' + 'This is what <strong>Test</strong> dials. When this credential is selected on a monitored device stream, only the token, ' + 'the <em>port</em> and the TLS setting are used — the request goes to that device’s own address, not to this host.</p>' +
    '</div>' +
    '<div class="form-group"><label>API Token</label>' +
      '<input type="password" id="f-rest-token" value="' + escapeHtml(cfg.apiToken || "") + '">' +
      '<p class="hint">Sent as <code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="checkbox" id="f-rest-verifytls"' + (cfg.verifyTls === true ? " checked" : "") + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
      '<p class="hint">Off by default to match FortiOS REST behaviour where self-signed device certs are common. Turn on when targeting a host with a real certificate.</p>' +
    '</div>' +
    credAllowRebootHTML(cfg,
      "Lets this token reboot a FortiGate it is set on (FortiOS <code>system/os/reboot</code>), and restart the FortiSwitches and FortiAPs that FortiGate manages.")
  );
}

/**
 * The `http` credential form — AUTHENTICATION ONLY since 2026-08. Everything
 * that describes the check itself (scheme, port, path, expected status,
 * expected content, match mode, TLS verification) moved to the manufacturer
 * custom widget that owns the check, and is additionally settable ad hoc in the
 * Test Connection modal so a check can be dialled in before it is saved.
 *
 * There is no "None" option: a credential exists to authenticate, and an
 * unauthenticated check is expressed by a widget with no credential attached.
 */
function credHttpForm(cfg) {
  var authMode = httpAuthModeOf(cfg);
  // A pre-split credential can resolve to "none" (it authenticated nothing).
  // The select has no such option, so land it on bearer rather than rendering a
  // dropdown whose value silently isn't in its own list.
  if (authMode === "none") authMode = "bearer";
  return (
    // Sits directly under the credential Type dropdown (which the modal shell
    // renders immediately above this host element), because the first thing to
    // establish is what this credential does NOT contain — operators arriving
    // from the old combined form look for the path here.
    // The global reset (styles.css `* { margin: 0 }`) zeroes margins on a bare
    // <p>, and `.hint` only gets spacing via `.form-group .hint` — which this
    // is not, sitting above the first group rather than inside one. So the
    // bottom margin is explicit, matching `.form-group`'s own 1rem rhythm.
    '<p class="hint" style="margin:0 0 1rem">What this credential is used to check — the path, the status code, the content the body must carry — is configured per manufacturer and model under <strong>Manufacturer Profiles → Custom Widgets</strong>. Use <strong>Test Connection</strong> below to try a check against a device before saving it there.</p>' +
    '<div class="form-group"><label>Authentication</label>' +
      '<select id="f-http-authmode" style="max-width:280px">' +
        '<option value="bearer"' + (authMode === "bearer" ? " selected" : "") + '>Bearer token</option>' +
        '<option value="basic"' +  (authMode === "basic"  ? " selected" : "") + '>Basic (cleartext)</option>' +
        '<option value="digest"' + (authMode === "digest" ? " selected" : "") + '>Digest (hashed)</option>' +
      '</select>' +
      // One alert per mode, all three riding the same data-http-auth mechanism
      // that shows/hides the carrier fields below — so exactly one is on screen
      // and none can drift out of sync with the selection.
      //
      // Every mode gets one because every mode is exposed over plain HTTP; what
      // differs is WHAT leaks. All three name Manufacturer Profiles rather than
      // offering a fix here, because `useHttps` is configured per CHECK on the
      // widget: a credential cannot control its own exposure, and that is
      // precisely what an operator would otherwise hunt for on this form.
      _httpAuthAlert("bearer",
        '<strong>The token is sent in cleartext</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Bearer sends it verbatim in the <code>Authorization</code> header, so anyone on the path can read it and reuse it.') +
      _httpAuthAlert("basic",
        '<strong>The username and password are sent in cleartext</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Basic sends them base64-encoded — encoding, not encryption — so anyone on the path can read them and reuse them.') +
      _httpAuthAlert("digest",
        '<strong>The password hash is readable</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Digest sends a hash instead of the password, so anyone on the path can attack it offline or replay it until the nonce expires ' +
        '— along with the username, which travels in the clear.') +
    '</div>' +
    '<div class="form-group" data-http-auth="bearer"><label>Bearer token</label>' +
      '<input type="password" id="f-http-token" value="' + escapeHtml(cfg.apiToken || "") + '">' +
      '<p class="hint">Sent as <code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest"><label>Username</label>' +
      '<input type="text" id="f-http-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest"><label>Password</label>' +
      '<input type="password" id="f-http-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>'
  );
}

/**
 * One mode-scoped warning box. Factored out so the three differ only in the
 * mode they belong to and the sentence they carry — the styling is the file's
 * existing `alert alert-warning` convention.
 */
function _httpAuthAlert(mode, bodyHTML) {
  return '<div class="alert alert-warning" data-http-auth="' + mode + '" ' +
    'style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(214,137,16,0.12);' +
    'border:1px solid var(--color-warning,#d68910);color:var(--color-text-primary);' +
    'font-size:0.82rem;margin:0.5rem 0 0.75rem">' +
      bodyHTML +
      ' HTTPS is set per check — tick <strong>Use HTTPS</strong> on the HTTP-check widget under Manufacturer Profiles → Custom Widgets.' +
    '</div>';
}

/**
 * Mirror of resolveHttpAuthMode in src/utils/httpCheck.ts. A credential saved
 * before the auth-mode field existed carries no `authMode`, and must render as
 * whatever it has always DONE — bearer when a token is set, basic when a
 * username/password pair is — rather than as "None", which would misreport an
 * authenticating credential and then strip its auth on the next save.
 */
function httpAuthModeOf(cfg) {
  var declared = cfg.authMode;
  if (declared === "none" || declared === "bearer" || declared === "basic" || declared === "digest") return declared;
  if (cfg.apiToken) return "bearer";
  if (cfg.username && cfg.password) return "basic";
  return "none";
}

/** Show only the carrier fields the selected auth mode actually sends. */
function wireHttpAuthModeToggle() {
  var sel = document.getElementById("f-http-authmode");
  if (!sel) return;
  function sync() {
    var mode = sel.value;
    var groups = document.querySelectorAll("[data-http-auth]");
    for (var i = 0; i < groups.length; i++) {
      var modes = (groups[i].getAttribute("data-http-auth") || "").split(" ");
      groups[i].style.display = modes.indexOf(mode) === -1 ? "none" : "";
    }
  }
  sel.addEventListener("change", sync);
  sync();
}

function readCredentialForm(type) {
  var cfg = _readCredentialFormFields(type);
  // Allow reboots (business rule 115) rides the SSH and REST API forms. Sent
  // on those types every time — an unticked box must clear a stored `true`,
  // since the server merges config onto the stored row.
  var allowReboot = document.getElementById("f-cred-allowreboot");
  if (allowReboot && (type === "ssh" || type === "restapi")) {
    cfg.allowReboot = allowReboot.checked;
  }
  return cfg;
}

function _readCredentialFormFields(type) {
  function num(v) { v = (v || "").trim(); return v ? Number(v) : undefined; }
  if (type === "snmp") {
    var version = document.getElementById("f-snmp-version").value;
    var port = num(document.getElementById("f-snmp-port").value);
    if (version === "v2c") {
      var cfg = { version: "v2c", community: document.getElementById("f-snmp-community").value };
      if (port !== undefined) cfg.port = port;
      return cfg;
    }
    var v3 = {
      version: "v3",
      username: document.getElementById("f-snmp-user").value,
      securityLevel: document.getElementById("f-snmp-seclevel").value,
      authProtocol: document.getElementById("f-snmp-authproto").value,
      authKey: document.getElementById("f-snmp-authkey").value,
      privProtocol: document.getElementById("f-snmp-privproto").value,
      privKey: document.getElementById("f-snmp-privkey").value,
    };
    if (port !== undefined) v3.port = port;
    return v3;
  }
  if (type === "winrm") {
    var w = {
      username: document.getElementById("f-winrm-user").value,
      password: document.getElementById("f-winrm-pass").value,
      useHttps: document.getElementById("f-winrm-https").checked,
      verifyTls: document.getElementById("f-winrm-verifytls").checked,
    };
    var wp = num(document.getElementById("f-winrm-port").value);
    if (wp !== undefined) w.port = wp;
    return w;
  }
  if (type === "restapi") {
    return {
      baseUrl: (document.getElementById("f-rest-baseurl").value || "").trim(),
      apiToken: document.getElementById("f-rest-token").value,
      verifyTls: document.getElementById("f-rest-verifytls").checked,
    };
  }
  if (type === "http") {
    // AUTH ONLY. The check definition moved to the manufacturer custom widget,
    // so this form no longer collects a path, status or body expectation.
    // NOTE: the carriers the selected mode does not send are stripped
    // SERVER-side (validateHttpConfig), not here. Blanking a secret field in
    // this payload means "keep the stored value" to
    // mergeConfigPreservingSecrets, so clearing it client-side would silently
    // preserve exactly the credential it looks like it is removing.
    return {
      authMode: document.getElementById("f-http-authmode").value,
      apiToken: document.getElementById("f-http-token").value,
      username: (document.getElementById("f-http-user").value || "").trim(),
      password: document.getElementById("f-http-pass").value,
    };
  }
  var s = {
    username: document.getElementById("f-ssh-user").value,
    password: document.getElementById("f-ssh-pass").value,
    privateKey: document.getElementById("f-ssh-key").value,
    passphrase: document.getElementById("f-ssh-passphrase").value,
    verifyHostKey: document.getElementById("f-ssh-verifyhostkey").checked,
  };
  var sp = num(document.getElementById("f-ssh-port").value);
  if (sp !== undefined) s.port = sp;
  return s;
}

async function deleteCredential(id, name) {
  var ok = await showConfirm('Delete credential "' + name + '"?');
  if (!ok) return;
  try {
    await api.credentials.delete(id);
    showToast("Credential deleted");
    await loadCredentialsTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}



// ────────────────────────────────────────────────────────────────────────
// Slice 6b — Editable Manufacturer Profile card.
// Renders a per-profile expandable list under Identification. Click the
// caret to load + show the full profile (metrics + per-model overrides);
// inline-edit defaults + add/edit/delete overrides. Custom-widget editor
// lives in Slice 7 (where the asset-details Custom MIB tab consumes it);
// for now we just surface the widget count per profile.
// ────────────────────────────────────────────────────────────────────────

// Keys mirror METRIC_KEYS in src/services/manufacturerProfileService.ts. The
// ORDER rows render in comes from the server (it sorts by that list, which
// follows the asset details slide-over: identity first, then the System tab's
// sections, then the tabs); this map only supplies labels.
var METRIC_KEY_LABELS = {
  model:             "Model identity",
  cpu:               "CPU",
  memory:            "Memory",
  temperature:       "Hardware Sensors",
  interfaces:        "Interfaces",
  lldp:              "LLDP",
  storage:           "Storage",
  wirelessStations:  "Wireless stations",
};

function manufacturerProfilesCardHTML() {
  var html = '<div class="settings-card">' +
    '<h4>Manufacturer Profiles</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      // Charon: rebranded; no "seeded from the built-in vendor profiles on first boot" (Charon does not seed them).
      'Per-manufacturer SNMP telemetry profile — pick which MIB symbol Charon walks ' +
      'for each System-tab metric, with optional per-model exceptions. Each row’s MIB cell says where its symbol ' +
      'resolves from — or what to upload when it does not: Charon ships the standard MIBs, ' +
      'a vendor’s MIBs come from you.' +
    '</p>';

  if (_mfgProfiles.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:0.75rem">No manufacturer profiles yet — the seeding job creates one per built-in vendor on first boot.</p>';
  } else {
    html += '<div id="mfg-profiles-list" style="margin-bottom:0.75rem">';
    _mfgProfiles.forEach(function (p) {
      html += renderProfileRow(p);
    });
    html += '</div>';
  }

  // Free-text box with a suggestion dropdown (the .aw-combo idiom, not a
  // <datalist> — most browsers won't open one on click). Any custom name is
  // still accepted; the list only steers toward spellings Polaris already
  // uses, so a new profile actually resolves for the assets that carry it.
  html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="aw-combo aw-combo-dim" style="flex:1;max-width:280px">' +
      '<input type="text" id="f-mfg-profile-add-name" autocomplete="off" placeholder="Manufacturer (e.g. Aruba)">' +
      '<div class="aw-suggest" id="mfg-profile-add-suggest"></div>' +
    '</span>' +
    '<button class="btn btn-primary" id="btn-add-mfg-profile">+ Add Manufacturer</button>' +
    '<button class="btn btn-secondary" id="btn-import-mfg-profile" title="Import a profile exported from Charon or Polaris, choosing which parts to bring in">Import…</button>' +
    '<input type="file" id="f-import-mfg-profile" accept=".json,application/json" style="display:none">' +
  '</div>';

  html += '</div>';
  return html;
}

function renderProfileRow(p) {
  var isOpen = !!_mfgProfileExpanded[p.id];
  var caret = isOpen ? "▼" : "▶";
  var html = '<div class="mfg-profile-row" data-profile-id="' + escapeHtml(p.id) + '" style="border:1px solid var(--color-border);border-radius:4px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(0,0,0,0.04))">' +
    '<div class="mfg-profile-header" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer">' +
      '<span class="mfg-profile-caret" style="font-family:var(--font-mono);font-size:0.75rem;width:14px">' + caret + '</span>' +
      '<span style="font-weight:600;flex:1">' + escapeHtml(p.manufacturer) + _mfgReadinessPillHTML(p) + '</span>' +
      '<span style="font-size:0.74rem;color:var(--color-text-secondary)">' +
        p.metricCount + ' metric' + (p.metricCount === 1 ? '' : 's') + ' · ' +
        p.overrideCount + ' override' + (p.overrideCount === 1 ? '' : 's') + ' · ' +
        p.widgetCount + ' widget' + (p.widgetCount === 1 ? '' : 's') + ' · ' +
        p.scopedMibCount + ' MIB' + (p.scopedMibCount === 1 ? '' : 's') +
      '</span>' +
      '<button class="btn btn-sm mfg-profile-code" data-id="' + escapeHtml(p.id) + '" title="View, edit, save or export this profile as JSON">View Code</button>' +
      '<button class="btn btn-sm btn-danger mfg-profile-del" data-id="' + escapeHtml(p.id) + '" title="Delete profile">Del</button>' +
    '</div>' +
    '<div class="mfg-profile-body" id="mfg-profile-body-' + escapeHtml(p.id) + '" style="' + (isOpen ? '' : 'display:none') + '">' +
      (isOpen && _mfgProfileDetail[p.id] ? renderProfileDetail(_mfgProfileDetail[p.id]) : (isOpen ? '<p class="empty-state" style="padding:0.75rem">Loading…</p>' : '')) +
    '</div>' +
  '</div>';
  return html;
}

function renderProfileDetail(detail) {
  var html = '<div style="padding:8px 12px 12px;border-top:1px solid var(--color-border)">';
  html += '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:6px">' +
    'Each row is one System-tab metric. The <b>Default</b> column is what Charon walks for ' +
    'every asset under this profile; a device type narrows that, and a model regex narrows it again.' +
  '</div>';
  html += _mfgMatchPatternHTML(detail);
  html += '<table class="ip-table" style="margin-bottom:8px"><thead><tr>' +
    '<th style="width:8%">Metric</th>' +
    '<th style="width:10%">Device type</th>' +
    '<th style="width:11%">Model</th>' +
    '<th style="width:16%">MIB</th>' +
    '<th style="width:9%">Type</th>' +
    '<th>Symbol</th>' +
    '<th style="width:11%">Transform</th>' +
    '<th style="width:140px">Action</th>' +
  '</tr></thead><tbody>';

  detail.metrics.forEach(function (m) {
    var editKey = detail.id + ":" + m.metricKey;
    var editing = !!_mfgProfileMetricEdit[editKey];
    html += '<tr data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '">' +
      '<td><b>' + escapeHtml(METRIC_KEY_LABELS[m.metricKey] || m.metricKey) + '</b></td>' +
      // DEVICE TYPE + MODEL columns for the profile-wide default row: the
      // entry the resolver falls back to when no device-type default and no
      // per-model exception matches, so both halves of its scope read "any".
      // Scoped rows fill these columns with their own device type / pattern.
      '<td>' + _mfgScopeBadge("ANY") + '</td>' +
      '<td>' + _mfgScopeBadge("DEFAULT") + '</td>';
    if (editing) {
      // Use the row's current MIB selection (if the operator has changed
      // it during this edit session it lives in the shadow store via the
      // change handler that also pre-warms `_mfgMibSymbolsCache`). For
      // first render fall back to the persisted defaultMibId /
      // defaultMibStdKey (joined into a single combined dropdown value).
      // Check `=== undefined` rather than truthiness so an explicit `""`
      // (operator picked "Built-in seed" to reset) is preserved instead of
      // being clobbered by the persisted value on re-render.
      var storedEditMib = _mfgEditMibId(detail.id, m.metricKey);
      var editMibId = (storedEditMib === undefined)
        ? joinMibSelection(m.defaultMibId, m.defaultMibStdKey)
        : storedEditMib;
      // Column order: MIB · Type · Symbol · Transform. Type picks first so
      // the Symbol cell renders 1 or 2 pickers and the Transform list
      // swaps between unary transforms and binary combiners.
      var editType = _mfgEditTypeFor("metric:" + detail.id + ":" + m.metricKey, m.defaultType);
      html +=
        '<td>' + renderMibSelect(editMibId, "mfg-edit-mib", detail.manufacturer) + '</td>' +
        '<td>' + renderTypeSelect(editType, "mfg-edit-type") + '</td>' +
        '<td>' + _symbolCellEditHTML(editType, editMibId, m.defaultSymbol, m.defaultSymbolB, "mfg-edit-sym") +
          _mfgExtraEditHTML(m.metricKey, "mfg-edit", { aggregate: m.defaultAggregate, label: m.defaultLabel, parsePattern: m.defaultParsePattern, parseTemplate: m.defaultParseTemplate, sensorColumns: m.defaultSensorColumns }) + '</td>' +
        '<td>' + renderTransformSelect(m.defaultTransform, "mfg-edit-transform", editType, m.metricKey) + '</td>' +
        '<td><button class="btn btn-sm btn-primary mfg-metric-save">Save</button> ' +
          '<button class="btn btn-sm btn-secondary mfg-metric-cancel">Cancel</button></td>';
    } else {
      var defaultDisplay = _symbolCellViewHTML(m.defaultType, m.defaultSymbol, m.defaultSymbolB);
      // The MIB cell is PROVENANCE, not the operator's pick: where the row's
      // symbol actually resolves from at this manufacturer's scope (module +
      // layer), or what to upload when it does not. The pinned MIB / std hint
      // is what the operator chose; the server's readiness is what is true.
      var mibDisplay = _mfgMibCellHTML(m.readiness, m.defaultMibId, m.defaultMibStdKey);
      var typeLabel = _MFG_TYPE_LABELS[m.defaultType] || m.defaultType;
      html +=
        '<td>' + mibDisplay + '</td>' +
        '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabel) + '</span></td>' +
        '<td>' + defaultDisplay + _mfgExtraViewHTML(m.metricKey, { aggregate: m.defaultAggregate, label: m.defaultLabel, parsePattern: m.defaultParsePattern, parseTemplate: m.defaultParseTemplate, sensorColumns: m.defaultSensorColumns }) + '</td>' +
        '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (m.defaultTransform ? escapeHtml(transformLabel(m.defaultTransform)) : "—") + '</span></td>' +
        '<td style="white-space:nowrap"><button class="btn btn-sm btn-secondary mfg-metric-edit">Edit</button> ' +
          '<button class="btn btn-sm btn-primary mfg-override-add-open" title="Add a device-type default or model exception for this metric">Add</button></td>';
    }
    html += '</tr>';

    // Scoped rows hang under the metric row, grouped so the hierarchy reads
    // top-down: each device type's default followed by that type's model
    // exceptions, then the model exceptions that apply to any device type.
    _mfgGroupOverrides(m.overrides).forEach(function (o) {
      html += renderOverrideRow(detail.id, m.metricKey, o, detail.manufacturer);
    });
    // Add-override form — single inline row (Model · Symbol · MIB · Type ·
    // Transform · Add) sized so wrap is rare on the typical Identification
    // tab width. Each cell of the parent table gets its own field so the
    // columns line up vertically with the metric row above. Drawn only after
    // the metric row's Add button opens it, so the table reads as a list.
    if (!_mfgOverrideAddOpen[editKey]) return;
    var newMibId = _mfgNewOverrideMibId(detail.id, m.metricKey) || null;
    // Add-override row layout matches the override view + edit rows:
    //   METRIC (blank) · MODEL (↳ add label + pattern input) · MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    // A device type with no pattern adds that type's DEFAULT; a pattern with
    // no device type adds a model exception for every type; both together
    // add a model exception under that type.
    var newTypeCell = '<td>' + _mfgDeviceTypeSelect(null, "mfg-new-override-assettype") + '</td>';
    var newPatternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.74rem">↳ add</span>' +
        '<input type="text" class="mfg-new-override-pattern" placeholder="Model regex (optional)" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var newType = _mfgEditTypeFor("new:" + detail.id + ":" + m.metricKey, "scalar");
    html += '<tr class="mfg-add-override-row" data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '" style="background:var(--color-bg-primary)">' +
      '<td></td>' +
      newTypeCell +
      newPatternCell +
      '<td>' + renderMibSelect(newMibId, "mfg-new-override-mib", detail.manufacturer, true) + '</td>' +
      '<td>' + renderTypeSelect(newType, "mfg-new-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(newType, newMibId, "", "", "mfg-new-override-sym") +
        _mfgExtraEditHTML(m.metricKey, "mfg-new-override", {}) + '</td>' +
      '<td>' + renderTransformSelect(null, "mfg-new-override-transform", newType, m.metricKey) + '</td>' +
      '<td style="white-space:nowrap"><button class="btn btn-sm btn-primary mfg-override-add">Add</button> ' +
        '<button class="btn btn-sm btn-secondary mfg-override-add-cancel">Cancel</button></td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  // ─── Custom widgets section ──────────────────────────────────────────
  // Each widget here renders on the asset details Custom MIB tab for every
  // asset whose alias-normalized manufacturer matches this profile (and
  // whose model satisfies the optional per-widget gate). Polaris probes
  // each widget on the telemetry cadence; the asset tab reads the latest
  // sample from AssetCustomWidgetSample.
  html += renderWidgetSection(detail);
  html += '</div>';
  return html;
}

// ─── Widget section + per-widget card renderers ────────────────────────
// Cards layout — one per widget — instead of a wide table. The metric
// table already eats most of the horizontal real estate; cramming 8-10
// fields per row here would force wrapping that breaks scan-ability.
// Each card has a compact view mode and an inline-expanded edit mode.

var WIDGET_TYPE_LABELS = {
  gauge: "Gauge", line: "Line chart", value: "Value", table: "Table",
  state: "State (0/1)", http: "HTTP check",
};
var WIDGET_TYPE_ORDER  = ["gauge", "line", "value", "table", "state", "http"];

// ─── State probes (widgetType "state") ──────────────────────────────────
// A status-shaped OID rather than a gauge: an alarm bit, a PSU present flag, a
// fan-tray OK register. The operator declares how a reading becomes true so
// Polaris never has to guess a vendor's polarity (SNMPv2 TruthValue is
// true(1)/false(2), plenty of enums use 2 for the bad state, some agents answer
// strings). Mirrors STATE_MAP_MODES in src/utils/stateProbes.ts — keep in step.
var STATE_MODE_LABELS = {
  nonzero:   "value is not 0  (plain alarm bit)",
  zero:      "value is 0  (inverted / health register)",
  equals:    "value is one of…",
  notEquals: "value is anything EXCEPT…",
  gte:       "value is ≥ …",
  lte:       "value is ≤ …",
};
var STATE_MODE_ORDER = ["nonzero", "zero", "equals", "notEquals", "gte", "lte"];
var STATE_MODES_WITH_VALUES = ["equals", "notEquals", "gte", "lte"];

function renderWidgetSection(detail) {
  var widgets = (detail.widgets || []).slice().sort(function (a, b) {
    if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
    return (a.name || "").localeCompare(b.name || "");
  });
  var html = '<div style="margin-top:18px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
      '<h5 style="margin:0;font-size:0.9rem;font-weight:600">Custom widgets</h5>' +
      (_mfgAddingWidget[detail.id]
        ? '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">New widget…</span>'
        : '<button class="btn btn-sm mfg-widget-add-toggle" data-profile-id="' + escapeHtml(detail.id) + '">+ Add Widget</button>') +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:8px">' +
      'Widgets render on the asset details <b>Custom MIB</b> tab for every asset whose manufacturer matches ' +
      'this profile. Each widget walks its symbol against the chosen MIB on the telemetry cadence.' +
    '</div>';
  if (widgets.length === 0 && !_mfgAddingWidget[detail.id]) {
    html += '<p class="empty-state" style="padding:0.5rem 0;margin:0;font-size:0.82rem">No widgets defined yet.</p>';
  }
  widgets.forEach(function (w) {
    html += renderWidgetCard(detail.id, w, detail.manufacturer);
  });
  if (_mfgAddingWidget[detail.id]) {
    html += renderAddWidgetCard(detail.id, detail.manufacturer);
  }
  html += '</div>';
  return html;
}

function renderWidgetCard(profileId, w, manufacturer) {
  if (_mfgWidgetEdit[w.id]) return renderWidgetEditCard(profileId, w, manufacturer);
  // View mode — single compact card.
  var mibLabel = w.mibId
    ? _mfgLookupMibLabel(w.mibId)
    : '<span style="color:var(--color-text-tertiary);font-style:italic">(no MIB)</span>';
  var modelLabel = w.modelPattern
    ? '<code style="font-size:0.78rem">' + escapeHtml(w.modelPattern) + '</code>'
    : '<span style="color:var(--color-text-tertiary)">any model</span>';
  var transformLabel_ = w.transform ? escapeHtml(transformLabel(w.transform)) : "—";
  var optsLabel = _widgetOptionsSummary(w);
  return '<div class="mfg-widget-card" data-profile-id="' + escapeHtml(profileId) + '" data-widget-id="' + escapeHtml(w.id) + '" style="border:1px solid var(--color-border);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--color-bg-primary)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
      '<span style="font-weight:600">' + escapeHtml(w.name) + '</span>' +
      '<span style="font-size:0.72rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.04em">' + escapeHtml(WIDGET_TYPE_LABELS[w.widgetType] || w.widgetType) + '</span>' +
      '<span style="flex:1"></span>' +
      // Which assets poll this widget (business rule 130). Needs assets write
      // on top of the profile key, like the server route.
      // Charon has no `assets` key (no inventory), so the Devices… picker never renders.
      (permAtLeast("assets", "write") ? '<button class="btn btn-sm mfg-widget-devices" title="Choose which devices poll this widget">Devices…</button> ' : '') +
      '<button class="btn btn-sm mfg-widget-edit">Edit</button>' +
      ' <button class="btn btn-sm btn-danger mfg-widget-del">Del</button>' +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px">' +
      '<span><b>MIB:</b> ' + mibLabel + '</span>' +
      '<span><b>Symbol:</b> <code style="font-size:0.78rem">' + escapeHtml(w.symbol) + '</code> <span style="color:var(--color-text-tertiary)">(' + escapeHtml(w.type) + ')</span></span>' +
      '<span><b>Model:</b> ' + modelLabel + '</span>' +
      '<span><b>Transform:</b> ' + transformLabel_ + '</span>' +
      (w.widgetType === "state"
        ? '<span style="grid-column:1/-1"><b>State:</b> ' + escapeHtml(_stateMapSummary(w.stateMap)) +
          (w.labelSymbol ? ' · rows named by <code style="font-size:0.78rem">' + escapeHtml(w.labelSymbol) + '</code>' : '') + '</span>'
        : (optsLabel ? '<span style="grid-column:1/-1"><b>Display:</b> ' + optsLabel + '</span>' : '')) +
    '</div>' +
  '</div>';
}

/** Plain-English mapping summary for the probe card — mirrors describeStateMap
 *  in src/utils/stateProbes.ts. */
function _stateMapSummary(m) {
  if (!m) return "no mapping";
  var t = m.trueLabel || "Alarm";
  var f = m.falseLabel || "OK";
  var vals = Array.isArray(m.values) ? m.values.join(", ") : "";
  switch (m.mode) {
    case "zero":      return t + " when the value is 0, " + f + " otherwise";
    case "equals":    return t + " when the value is " + vals + ", " + f + " otherwise";
    case "notEquals": return f + " when the value is " + vals + ", " + t + " otherwise";
    case "gte":       return t + " when the value is " + vals + " or more, " + f + " below that";
    case "lte":       return t + " when the value is " + vals + " or less, " + f + " above that";
    default:          return t + " when the value is not 0, " + f + " when it is 0";
  }
}

function renderWidgetEditCard(profileId, w, manufacturer) {
  var key = "widget:" + w.id;
  var storedMib = _mfgWidgetMibFor(key, joinMibSelection(w.mibId, null));
  var storedType = _mfgWidgetTypeFor(key, w.type);
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, w.widgetType);
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-edit-card",
    dataAttrs:        ' data-widget-id="' + escapeHtml(w.id) + '"',
    title:            "Edit widget",
    nameValue:        w.name,
    modelValue:       w.modelPattern || "",
    orderValue:       (w.order != null) ? w.order : 0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      w.symbol || "",
    transformValue:   w.transform,
    displayOptions:   w.displayOptions || {},
    stateMap:         w.stateMap || null,
    labelSymbol:      w.labelSymbol || "",
    httpCheck:        w.httpCheck || null,
    credentialId:     w.credentialId || "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-save",
    cancelBtnClass:   "mfg-widget-cancel",
    saveBtnLabel:     "Save",
  });
}

function renderAddWidgetCard(profileId, manufacturer) {
  var key = "new-widget:" + profileId;
  var storedMib = _mfgWidgetMibFor(key, "");
  var storedType = _mfgWidgetTypeFor(key, "scalar");
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, "gauge");
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-add-card",
    dataAttrs:        '',
    title:            "New widget",
    nameValue:        "",
    modelValue:       "",
    orderValue:       0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      "",
    transformValue:   null,
    displayOptions:   {},
    stateMap:         null,
    labelSymbol:      "",
    httpCheck:        null,
    credentialId:     "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-add-save",
    cancelBtnClass:   "mfg-widget-add-cancel",
    saveBtnLabel:     "Add widget",
  });
}

// Shared form renderer for both Edit and Add. Field IDs/classes are the
// same in both modes — the save handler dispatches off the form's outer
// class (mfg-widget-edit-card vs mfg-widget-add-card) instead of unique
// per-field selectors.
function _renderWidgetFormCard(o) {
  var snmpHidden = o.widgetTypeSelected === "http";
  var html = '<div class="' + o.formClass + '" data-profile-id="' + escapeHtml(o.profileId) + '"' + o.dataAttrs + ' style="border:1px solid var(--color-primary,#4fc3f7);border-radius:6px;padding:10px 12px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(127,127,127,0.04))">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="font-weight:600;font-size:0.85rem">' + escapeHtml(o.title) + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm btn-primary ' + o.saveBtnClass + '">' + escapeHtml(o.saveBtnLabel) + '</button>' +
      ' <button class="btn btn-sm ' + o.cancelBtnClass + '">Cancel</button>' +
    '</div>' +
    // Field grid — name + widget-type + MIB + symbol-type + symbol + transform + model + order
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Name *",
        '<input type="text" class="mfg-widget-name" value="' + escapeHtml(o.nameValue) + '" placeholder="e.g. Connected wireless clients" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Widget type",
        _widgetTypeSelectHTML("mfg-widget-widgettype", o.widgetTypeSelected)) +
      // The SNMP quartet is hidden (not removed) on an http widget: the check
      // names a request, not an OID. Hidden rather than removed so a
      // typed-then-reconsidered symbol survives flipping the type back and
      // forth before save — the same reasoning as the monitor-settings rows.
      _widgetFormField("MIB *",
        renderMibSelect(o.mibSelected, "mfg-widget-mib", o.manufacturer, true), snmpHidden) +
      _widgetFormField("Symbol type",
        renderWidgetTypeSelect(o.typeSelected, "mfg-widget-type"), snmpHidden) +
      _widgetFormField("Symbol *",
        renderSymbolPicker(o.symbolValue, o.mibSelected, "mfg-widget-symbol", o.typeSelected), snmpHidden) +
      _widgetFormField("Transform",
        renderTransformSelect(o.transformValue, "mfg-widget-transform"), snmpHidden) +
      _widgetFormField("Model regex (optional)",
        '<input type="text" class="mfg-widget-model" value="' + escapeHtml(o.modelValue) + '" placeholder="e.g. FortiAP-231F" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Order",
        '<input type="number" class="mfg-widget-order" value="' + escapeHtml(String(o.orderValue)) + '" min="0" step="1" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    // A state probe's second block is its true/false mapping, not display
    // options — the mapping is what makes the probe alertable, so it takes the
    // prominent slot rather than hiding behind a gauge's min/max.
    '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--color-border)">' +
      (o.widgetTypeSelected === "http"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">HTTP check</div>' +
          _widgetHttpCheckForm(o.httpCheck, o.credentialId)
        : o.widgetTypeSelected === "state"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">State mapping</div>' +
          _widgetStateOptionsForm(o.stateMap, o.labelSymbol, o.typeSelected)
        : '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">Display options</div>' +
          _widgetDisplayOptionsForm(o.widgetTypeSelected, o.displayOptions)) +
    '</div>' +
  '</div>';
  return html;
}

/**
 * The state-probe mapping sub-form. Everything here is operator-declared because
 * no part of it can be inferred from the MIB: which raw values mean "bad", what
 * to call the two states, which side is the interesting one, and (for a table)
 * which sibling column names the rows.
 */
function _widgetStateOptionsForm(stateMap, labelSymbol, symbolType) {
  var m = stateMap || {};
  var mode = m.mode || "nonzero";
  var values = Array.isArray(m.values) ? m.values.join(", ") : "";
  var needsValues = STATE_MODES_WITH_VALUES.indexOf(mode) !== -1;
  var modeOpts = STATE_MODE_ORDER.map(function (k) {
    return '<option value="' + k + '"' + (mode === k ? " selected" : "") + '>' + escapeHtml(STATE_MODE_LABELS[k]) + '</option>';
  }).join("");
  return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
    _widgetFormField("True when",
      '<select class="mfg-widget-statemode" style="width:100%;font-size:0.82rem">' + modeOpts + '</select>') +
    _widgetFormField("Comparison value(s)",
      '<input type="text" class="mfg-widget-statevalues" value="' + escapeHtml(values) + '" placeholder="comma-separated, e.g. 2, alarm" style="width:100%;font-size:0.82rem"' +
        (needsValues ? "" : " disabled") + '>') +
    _widgetFormField("Label for the true state",
      '<input type="text" class="mfg-widget-statetrue" value="' + escapeHtml(m.trueLabel || "Alarm") + '" maxlength="32" placeholder="Alarm" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Label for the false state",
      '<input type="text" class="mfg-widget-statefalse" value="' + escapeHtml(m.falseLabel || "OK") + '" maxlength="32" placeholder="OK" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Row-name symbol (optional, tables)",
      '<input type="text" class="mfg-widget-labelsymbol" value="' + escapeHtml(labelSymbol || "") + '" placeholder="e.g. fgHwSensorEntName" style="width:100%;font-size:0.82rem"' +
        (symbolType === "table" ? "" : " disabled") + '>') +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.74rem;color:var(--color-text-secondary)">' +
      '<input type="checkbox" class="mfg-widget-stateproblem"' + (m.trueIsProblem === false ? "" : " checked") + '>' +
      '<span>The true state is the problem</span>' +
    '</label>' +
  '</div>' +
  '<p style="font-size:0.74rem;color:var(--color-text-tertiary);margin:8px 0 0">' +
    'Readings are stored as 0/1 using this mapping, so an automation can alert on the state directly. ' +
    'A table probe produces one independent flag per row — give it a row-name symbol from the same table ' +
    '(joined on the OID index) or rows will only be identifiable by index, which differs per model. ' +
    'A value the mapping can\'t compare is recorded as no reading rather than as healthy.' +
  '</p>';
}

function _widgetFormField(label, controlHTML, hidden) {
  // `hidden` keeps a field in the DOM but out of sight — used for the SNMP
  // quartet on an http widget, which names a request rather than an OID.
  // Hidden rather than omitted so the shadow store still finds the inputs and a
  // typed-then-reconsidered symbol survives flipping the type back and forth
  // before save (the monitor-settings precedent).
  var style = 'display:flex;flex-direction:column;gap:2px;font-size:0.74rem;color:var(--color-text-secondary)';
  if (hidden) style = 'display:none';
  return '<label style="' + style + '">' +
    '<span>' + escapeHtml(label) + '</span>' +
    controlHTML +
  '</label>';
}

/**
 * The HTTP-check sub-form — the check definition that used to live on an `http`
 * credential. It sits on the manufacturer profile because a check varies by
 * vendor AND MODEL (every Axis camera answers the same VAPIX path) while a
 * login varies by vendor or site; keeping both on a credential meant a second
 * path needed a second copy of the same password.
 *
 * "Applies to" is the existing `modelPattern` field in the grid above — blank
 * means every asset of this manufacturer, which is the common case and is why
 * the hint says so rather than leaving an empty box to interpret.
 */
function _widgetHttpCheckForm(check, credentialId) {
  var c = check || {};
  var creds = (_credentialCache.list || []).filter(function (x) { return x.type === "http"; });
  var opts = '<option value="">None — unauthenticated</option>';
  creds.forEach(function (x) {
    opts += '<option value="' + escapeHtml(x.id) + '"' + (credentialId === x.id ? " selected" : "") + '>' + escapeHtml(x.name) + '</option>';
  });
  var mode = c.matchMode === "regex" ? "regex" : "contains";
  return '' +
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Credential",
        '<select class="mfg-http-cred" style="width:100%;font-size:0.82rem">' + opts + '</select>') +
      _widgetFormField("Path",
        '<input type="text" class="mfg-http-path" value="' + escapeHtml(c.path || "") + '" placeholder="/healthz" style="width:100%;font-size:0.82rem">') +
      // Same opt-in shape as the Test Connection modal: the scheme implies a
      // port, so the field is disabled until an operator says otherwise. A
      // stored port IS a custom port, which is what pre-ticks the box.
      _widgetFormField("Port",
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-bottom:3px">' +
          '<input type="checkbox" class="mfg-http-customport"' + (c.port ? " checked" : "") + '><span>Custom port</span>' +
        '</label>' +
        '<input type="number" class="mfg-http-port" value="' + escapeHtml(c.port ? String(c.port) : "") + '" min="1" max="65535" ' +
          'placeholder="default (' + (c.useHttps === true ? "443" : "80") + ')" style="width:100%;font-size:0.82rem"' +
          (c.port ? "" : " disabled") + '>') +
      _widgetFormField("Expected status",
        '<input type="number" class="mfg-http-status" value="' + escapeHtml(c.expectStatus ? String(c.expectStatus) : "") + '" min="100" max="599" placeholder="any 2xx" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Match",
        '<select class="mfg-http-matchmode" style="width:100%;font-size:0.82rem">' +
          '<option value="contains"' + (mode === "contains" ? " selected" : "") + '>Contains</option>' +
          '<option value="regex"' + (mode === "regex" ? " selected" : "") + '>Regex</option>' +
        '</select>' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-top:4px">' +
          '<input type="checkbox" class="mfg-http-casesensitive"' + (c.caseSensitive === true ? " checked" : "") + '>' +
          '<span>Case sensitive</span>' +
        '</label>') +
      _widgetFormField("Expected content",
        '<input type="text" class="mfg-http-body" value="' + escapeHtml(c.expectBody || "") + '" placeholder="e.g. OK" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.8rem">' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-https"' + (c.useHttps === true ? " checked" : "") + '><span>Use HTTPS</span></label>' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-verifytls"' + (c.verifyTls === true ? " checked" : "") + '><span>Verify TLS</span></label>' +
    '</div>' +
    '<p class="hint" style="margin-top:8px">Records a pass/fail 0/1 (alertable as <strong>Custom state value</strong>) plus the response time — a wrong status code or missing content is recorded as a failure, and it is an <strong>automation</strong> that decides whether that means the device is down. Leave <strong>Model regex</strong> above blank to check every ' + '' + 'device of this manufacturer. Dial the check in against a real device from <strong>Credentials → Test Connection</strong> first.</p>';
}

/** Collect the HTTP-check sub-form. Blank numbers mean "use the default". */
function _readWidgetHttpCheck(scope) {
  function val(cls) { var el = scope.querySelector(cls); return el ? el.value : ""; }
  function chk(cls) { var el = scope.querySelector(cls); return !!(el && el.checked); }
  function numOrNull(cls) { var v = (val(cls) || "").trim(); return v ? Number(v) : null; }
  return {
    useHttps:       chk(".mfg-http-https"),
    // Un-ticked Custom port sends null, so clearing the override actually
    // returns the check to the scheme default.
    port:           chk(".mfg-http-customport") ? numOrNull(".mfg-http-port") : null,
    path:           (val(".mfg-http-path") || "").trim(),
    expectStatus:   numOrNull(".mfg-http-status"),
    expectBody:     val(".mfg-http-body"),
    matchMode:      val(".mfg-http-matchmode") || "contains",
    caseSensitive:  chk(".mfg-http-casesensitive"),
    verifyTls:      chk(".mfg-http-verifytls"),
  };
}

function _widgetTypeSelectHTML(cls, current) {
  var v = current || "gauge";
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.82rem">';
  WIDGET_TYPE_ORDER.forEach(function (k) {
    html += '<option value="' + k + '"' + (v === k ? " selected" : "") + '>' + escapeHtml(WIDGET_TYPE_LABELS[k]) + '</option>';
  });
  html += '</select>';
  return html;
}

// Per-widgetType displayOptions sub-form. Fields match what the asset
// Custom MIB tab consumes today:
//   gauge → min, max, unit, warningAt + warningWhen
//   line  → unit, warningAt + warningWhen
//   table → no operator-tunable options; the renderer derives columns
//           from the latest sample.
// warningAt / warningWhen only paint the card (_customWidgetWarning in
// assets.js); alerting on the value is an automation's job.
//
// How a single-value widget's number reads (the asset tab's _cwDisplay):
// "" = a plain number with its unit; a duration format reads it as seconds or
// SNMP TimeTicks (hundredths of a second) and shows "1 h 23 m".
var WIDGET_VALUE_FORMATS = [
  ["", "Number"],
  ["duration_s", "Duration (from seconds)"],
  ["duration_ticks", "Duration (from TimeTicks)"],
];
var WIDGET_UNIT_HINT = '<div class="hint" style="grid-column:1/-1;margin:0;font-size:0.74rem">' +
  'Set the unit to <b>°C</b> or <b>°F</b> for a temperature: it is shown in the install\'s temperature unit, converted when they differ.' +
'</div>';

function _widgetFormatSelectHTML(current) {
  return '<select class="mfg-widget-opt-format" style="width:100%;font-size:0.82rem">' +
    WIDGET_VALUE_FORMATS.map(function (f) {
      return '<option value="' + f[0] + '"' + ((current || "") === f[0] ? " selected" : "") + '>' + f[1] + '</option>';
    }).join("") +
  '</select>';
}

function _widgetDisplayOptionsForm(widgetType, opts) {
  var o = opts || {};
  function num(v) { return (v === null || v === undefined) ? "" : String(v); }
  function warnFields() {
    var below = o.warningWhen === "below";
    return _widgetFormField("Warning at", '<input type="number" class="mfg-widget-opt-warning" value="' + escapeHtml(num(o.warningAt)) + '" step="any" placeholder="none" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Warn when", '<select class="mfg-widget-opt-warning-when" style="width:100%;font-size:0.82rem">' +
        '<option value="above"' + (below ? "" : " selected") + '>at or above</option>' +
        '<option value="below"' + (below ? " selected" : "") + '>at or below</option>' +
      '</select>');
  }
  if (widgetType === "gauge") {
    return '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Min", '<input type="number" class="mfg-widget-opt-min" value="' + escapeHtml(num(o.min)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Max", '<input type="number" class="mfg-widget-opt-max" value="' + escapeHtml(num(o.max)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Unit", '<input type="text"   class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. %, °C or clients" style="width:100%;font-size:0.82rem">') +
      warnFields() +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  if (widgetType === "line") {
    return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Unit", '<input type="text" class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. bps, % or °C" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      warnFields() +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  // A Value widget is the reading as text — no threshold is drawn on it.
  if (widgetType === "value") {
    return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Unit", '<input type="text" class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. bps, % or °C" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  // table — no editable options
  return '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">Table widgets render every column from the latest sample. No display options to configure.</div>';
}

// Compact one-line summary of displayOptions for the view card.
function _widgetOptionsSummary(w) {
  var o = w.displayOptions || {};
  var parts = [];
  if (w.widgetType === "gauge") {
    if (o.min != null) parts.push("min " + o.min);
    if (o.max != null) parts.push("max " + o.max);
    if (o.unit)        parts.push("unit " + o.unit);
    if (o.warningAt != null) parts.push("warn " + (o.warningWhen === "below" ? "≤ " : "≥ ") + o.warningAt);
  } else if (w.widgetType === "line" || w.widgetType === "value") {
    if (o.unit) parts.push("unit " + o.unit);
    if (o.warningAt != null) parts.push("warn " + (o.warningWhen === "below" ? "≤ " : "≥ ") + o.warningAt);
  }
  if (o.format) {
    var f = WIDGET_VALUE_FORMATS.find(function (x) { return x[0] === o.format; });
    if (f) parts.push(f[1].toLowerCase());
  }
  return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

// Read displayOptions back from a form scope (an edit card or add card).
// Empty / non-numeric values are dropped so the stored JSON stays tight.
function _readWidgetDisplayOptions(scope, widgetType) {
  function numOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    if (s === "") return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function strOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    return s === "" ? null : s;
  }
  var out = {};
  // The direction is stored only beside a threshold, and only when it is the
  // non-default "below" — absent means "above".
  function readWarn() {
    var warn = numOrNull(scope.querySelector(".mfg-widget-opt-warning"));
    if (warn == null) return;
    out.warningAt = warn;
    var when = scope.querySelector(".mfg-widget-opt-warning-when");
    if (when && when.value === "below") out.warningWhen = "below";
  }
  if (widgetType === "gauge") {
    var min  = numOrNull(scope.querySelector(".mfg-widget-opt-min"));
    var max  = numOrNull(scope.querySelector(".mfg-widget-opt-max"));
    var unit = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    if (min != null)  out.min = min;
    if (max != null)  out.max = max;
    if (unit)         out.unit = unit;
    readWarn();
  } else if (widgetType === "line" || widgetType === "value") {
    var unitL = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    if (unitL) out.unit = unitL;
    readWarn();
  }
  if (widgetType === "gauge" || widgetType === "line" || widgetType === "value") {
    var fmt = strOrNull(scope.querySelector(".mfg-widget-opt-format"));
    if (fmt) out.format = fmt;
  }
  return out;
}

function renderOverrideRow(profileId, metricKey, o, manufacturer) {
  var editing = !!_mfgProfileOverrideEdit[o.id];
  // Override rows leave the METRIC column blank (the default row above
  // already names the metric). The MODEL column carries the override's
  // identity — the regex literal in view mode, a Model regex input in
  // edit mode. The leading ↳ visually nests the row under its default.
  var head = '<tr class="mfg-override-row" data-profile-id="' + escapeHtml(profileId) +
    '" data-metric-key="' + escapeHtml(metricKey) +
    '" data-override-id="' + escapeHtml(o.id) + '" style="background:var(--color-bg-primary)">' +
    '<td></td>';
  if (editing) {
    var oMibId = _mfgOverrideEditMibId(o.id);
    if (oMibId === undefined) oMibId = joinMibSelection(o.mibId, o.mibStdKey); // first render: persisted value
    // Column order matches the metric default row above:
    //   METRIC (blank) · DEVICE TYPE (select) · MODEL (↳ pattern input) ·
    //   MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    // Clearing the pattern on a type-scoped row promotes it to that type's
    // default; clearing it on an any-type row is refused by the server,
    // since the row would then match nothing.
    var scopeTypeCell = '<td>' + _mfgDeviceTypeSelect(o.assetType || null, "mfg-edit-override-assettype") + '</td>';
    var patternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span>' +
        '<input type="text" class="mfg-edit-override-pattern" value="' + escapeHtml(o.modelPattern || "") + '" placeholder="Model regex (optional)" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var oEditType = _mfgEditTypeFor("override:" + o.id, o.type);
    return head +
      scopeTypeCell +
      patternCell +
      '<td>' + renderMibSelect(oMibId, "mfg-edit-override-mib", manufacturer) + '</td>' +
      '<td>' + renderTypeSelect(oEditType, "mfg-edit-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(oEditType, oMibId, o.symbol, o.symbolB, "mfg-edit-override-sym") +
        _mfgExtraEditHTML(metricKey, "mfg-edit-override", { aggregate: o.aggregate, label: o.label, parsePattern: o.parsePattern, parseTemplate: o.parseTemplate, sensorColumns: o.sensorColumns }) + '</td>' +
      '<td>' + renderTransformSelect(o.transform, "mfg-edit-override-transform", oEditType, metricKey) + '</td>' +
      '<td><button class="btn btn-sm btn-primary mfg-override-save">Save</button> ' +
        '<button class="btn btn-sm btn-secondary mfg-override-cancel">Cancel</button></td>' +
    '</tr>';
  }
  var mibLabel = _mfgMibCellHTML(o.readiness, o.mibId, o.mibStdKey);
  // DEVICE TYPE + MODEL columns carry the row's scope, indented to show its
  // tier: a device-type default sits one level under the profile default, a
  // model exception one level under the type it belongs to.
  var isTypeDefault = !!o.assetType && !o.modelPattern;
  var deviceCell = o.assetType
    ? '<td style="padding-left:' + (isTypeDefault ? 20 : 32) + 'px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span> ' +
        '<span style="font-size:0.78rem;font-weight:600">' + escapeHtml(_dtLabelFor(o.assetType)) + '</span>' +
      '</td>'
    : '<td>' + _mfgScopeBadge("ANY") + '</td>';
  var modelCell = o.modelPattern
    ? '<td style="padding-left:' + (o.assetType ? 32 : 20) + 'px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span> ' +
        '<code style="font-size:0.8rem">' + escapeHtml(o.modelPattern) + '</code>' +
      '</td>'
    : '<td style="padding-left:20px">' + _mfgScopeBadge("DEFAULT") + '</td>';
  var typeLabelO = _MFG_TYPE_LABELS[o.type] || o.type;
  return head +
    deviceCell +
    modelCell +
    '<td><span style="font-size:0.78rem">' + mibLabel + '</span></td>' +
    '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabelO) + '</span></td>' +
    '<td>' + _symbolCellViewHTML(o.type, o.symbol, o.symbolB) +
      _mfgExtraViewHTML(metricKey, { aggregate: o.aggregate, label: o.label, parsePattern: o.parsePattern, parseTemplate: o.parseTemplate, sensorColumns: o.sensorColumns }) + '</td>' +
    '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (o.transform ? escapeHtml(transformLabel(o.transform)) : "—") + '</span></td>' +
    '<td><button class="btn btn-sm btn-secondary mfg-override-edit">Edit</button> ' +
      '<button class="btn btn-sm btn-danger mfg-override-del">Del</button></td>' +
  '</tr>';
}

// Standard MIB hints the operator can pin on a metric row or override.
// Keys mirror `_SNMP_STANDARD_MIBS` in `public/js/assets.js` (the SNMP Walk
// dropdown) and the `STD_MIB_KEYS` set in `manufacturerProfileService.ts`.
// `std:fortinet` deliberately omitted — vendor MIBs belong in the Uploaded
// MIBs section, not the Standard MIBs optgroup.
var STD_MIB_LABELS = {
  "std:system":         "System (RFC 1213)",
  "std:interfaces":     "Interfaces — ifTable (RFC 2863)",
  "std:if-ext":         "Interfaces — ifXTable, 64-bit counters (RFC 2863)",
  "std:host-resources": "HOST-RESOURCES-MIB (RFC 2790)",
  "std:entity":         "ENTITY-MIB (RFC 4133)",
  "std:entity-sensor":  "ENTITY-SENSOR-MIB (RFC 3433)",
  "std:lldp":           "LLDP-MIB (IEEE 802.1AB)",
  "std:poe":            "PoE — POWER-ETHERNET-MIB (RFC 3621)",
  "std:bridge":         "Bridge — MAC forwarding + STP (RFC 4188)",
  "std:q-bridge":       "Bridge — VLAN-aware forwarding (RFC 4363)",
  "std:rstp":           "Rapid Spanning Tree (RFC 4318)",
  "std:ip":             "IP — addresses + neighbour cache (RFC 4293)",
};
var STD_MIB_ORDER = ["std:system", "std:interfaces", "std:if-ext", "std:host-resources", "std:entity", "std:entity-sensor", "std:lldp", "std:poe", "std:bridge", "std:q-bridge", "std:rstp", "std:ip"];

// Splits a single dropdown value into the {mibId, mibStdKey} pair the
// backend expects. The dropdown carries one combined string ("" = built-in
// seed, "std:*" = standard MIB hint, otherwise a UUID = uploaded MIB) so
// the operator only has to pick once.
function splitMibSelection(value) {
  if (!value) return { mibId: null, mibStdKey: null };
  if (value.indexOf("std:") === 0) return { mibId: null, mibStdKey: value };
  return { mibId: value, mibStdKey: null };
}

// Inverse of splitMibSelection — turns the persisted pair into the single
// string the dropdown's <option value=…> expects. Std key wins when both
// are non-null (defensive — the backend rejects that combination).
function joinMibSelection(mibId, mibStdKey) {
  if (mibStdKey) return mibStdKey;
  if (mibId)     return mibId;
  return "";
}

// ─── "Also applies when" (the profile's match pattern) ─────────────────
//
// A profile is normally found by its CANONICAL manufacturer, and that is the
// only lookup for an asset whose manufacturer the alias map already folds
// into this profile's name. `matchPattern` is the second chance, consulted
// ONLY when no profile is keyed by the asset's manufacturer, and tested
// case-insensitively against `manufacturer os pinnedMibModuleName` — so it
// covers the three cases the hardcoded vendor constant's regex covered:
//   · an alias spelling the seed did not key ("Aruba", "HPE" → the HP profile)
//   · OS-only identity (SNMP reports "Cisco IOS" and no manufacturer)
//   · a MIB-pin redirect (the asset's pinned MIB module names the vendor)
// Empty is the normal state for an operator-made profile; the seeded ones
// carry the constant's alternations, backfilled by the Phase 4 migration.
function _mfgMatchPatternHTML(detail) {
  var v = detail.matchPattern || "";
  return '<div class="mfg-profile-scope" data-profile-id="' + escapeHtml(detail.id) + '" ' +
      'style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
    '<span style="font-size:0.78rem;color:var(--color-text-secondary);white-space:nowrap">Also applies when</span>' +
    '<input type="text" class="mfg-matchpattern" value="' + escapeHtml(v) + '" ' +
      'placeholder="Manufacturer / OS regex, e.g. aruba|hpe|procurve" ' +
      'title="Case-insensitive regex tested against the asset\'s manufacturer, OS and pinned MIB module — used only when no profile is keyed by its manufacturer" ' +
      'style="flex:1;min-width:200px;font-size:0.78rem">' +
    '<button class="btn btn-sm mfg-matchpattern-save">Save</button>' +
    '<span style="font-size:0.72rem;color:var(--color-text-tertiary)">' +
      'Only consulted when no profile matches the asset\'s manufacturer. Leave blank for none.' +
    '</span>' +
  '</div>';
}

async function saveMatchPattern(el) {
  var box = el.closest(".mfg-profile-scope");
  if (!box) return;
  var profileId = box.getAttribute("data-profile-id");
  var input = box.querySelector(".mfg-matchpattern");
  var value = ((input || {}).value || "").trim();
  try {
    // Null clears it — an empty string would store a regex that matches
    // everything, which is the opposite of "no second chance".
    var resp = await api.serverSettings.updateManufacturerProfile(profileId, { matchPattern: value || null });
    // Same refresh shape as every other write on this card: fold the returned
    // profile into the detail cache, then re-render from it.
    if (resp && resp.profile) _mfgProfileDetail[profileId] = resp.profile;
    showToast(value ? "Match pattern saved" : "Match pattern cleared");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save match pattern failed", "error");
  }
}

// ─── Scope helpers (device type + model pattern) ───────────────────────
//
// A scoped row under a metric carries (assetType, modelPattern) and at least
// one of the two. The three shapes render as three tiers:
//   assetType only   → that DEVICE TYPE'S DEFAULT, one indent in
//   both             → a model exception under that type, two indents in
//   modelPattern only→ a model exception for any device type
// Identical wording lives in manufacturerProfileService's MetricOverrideRow.

// The small uppercase marker the DEFAULT / ANY cells use, so the profile-wide
// row and the device-type rows read as the same kind of thing.
function _mfgScopeBadge(text) {
  return '<span style="font-size:0.74rem;font-weight:600;letter-spacing:0.04em;color:var(--color-text-tertiary)">' +
    escapeHtml(text) + '</span>';
}

// Order the scoped rows into the hierarchy the table draws: per device type
// (alphabetical by the label the operator sees), that type's default first
// and its model exceptions after, then the any-type model exceptions last.
// Within a tier the server's `order` is preserved — it decides which regex
// wins at probe time, so the page must not show a different sequence.
function _mfgGroupOverrides(overrides) {
  var rows = (overrides || []).slice();
  var types = [];
  rows.forEach(function (o) {
    if (o.assetType && types.indexOf(o.assetType) === -1) types.push(o.assetType);
  });
  types.sort(function (a, b) { return _dtLabelFor(a).localeCompare(_dtLabelFor(b)); });
  var out = [];
  types.forEach(function (t) {
    rows.forEach(function (o) { if (o.assetType === t && !o.modelPattern) out.push(o); });
    rows.forEach(function (o) { if (o.assetType === t && o.modelPattern) out.push(o); });
  });
  rows.forEach(function (o) { if (!o.assetType) out.push(o); });
  return out;
}

// Device-type picker, drawn from the asset-type REGISTRY (`_assetTypes`, the
// same list the Device Types card edits) rather than a hardcoded four, so a
// custom type an operator added can carry a default too. "Any device type"
// is the empty value.
function _mfgDeviceTypeSelect(selected, cls) {
  var types = (_assetTypes || []).slice().sort(function (a, b) {
    return (a.label || a.name || "").localeCompare(b.label || b.name || "");
  });
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.78rem">' +
    '<option value=""' + (selected ? '' : ' selected') + '>Any device type</option>';
  var known = false;
  types.forEach(function (t) {
    if (t.name === selected) known = true;
    html += '<option value="' + escapeHtml(t.name) + '"' + (t.name === selected ? ' selected' : '') + '>' +
      escapeHtml(t.label || t.name) + '</option>';
  });
  // A stored type the registry no longer carries (renamed or deleted) must
  // still be selectable, or opening the editor would silently rewrite the
  // row's scope to "any" on the next save.
  if (selected && !known) {
    html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + ' (unknown)</option>';
  }
  return html + '</select>';
}

// ─── The row facts the hardcoded profile used to own ───────────────────
//
// Three metric-specific extras live under the Symbol cell, keyed by metric:
//   cpu / memory          → aggregate: how a walked subtree collapses
//                           (none | avg | sum) — Cisco pools are summed,
//                           Juniper buffers averaged.
//   storage / temperature → label: the sample row's name ("flash" for a
//                           FortiSwitch's storage; "System" for a FortiAP's
//                           one temperature).
//   model                 → parse pattern + template turning the raw vendor
//                           scalar into Asset.model ("FortiSwitch $1").
// Every input carries an `mfg-<prefix>-…` class, which is what the
// form-preserve snapshot keys on, so nothing typed here is lost to a chained
// re-render.

var _MFG_AGGREGATE_LABELS = { none: "as read", avg: "average rows", sum: "sum rows" };

// Hardware Sensors (temperature) carries the label for a scalar row AND, for a
// `table` row, the sensor table's sibling columns (business rule 132): the row's
// Symbol is the VALUE column; these name the row-name column, an alarm column
// and how its reading maps to alarm / ok, an optional fixed class and a scale.
// The server keeps the columns on a table row only and clears them otherwise.
var _MFG_SENSOR_CLASSES = ["temperature", "fan", "voltage", "current", "optical", "poe", "power", "disk", "other"];
var _MFG_ALARM_MODES = { nonzero: "not 0", zero: "is 0", equals: "is one of", notEquals: "is not one of", gte: "at least", lte: "at most" };

function _mfgExtrasFor(metricKey) {
  if (metricKey === "cpu" || metricKey === "memory") return "aggregate";
  if (metricKey === "storage") return "label";
  if (metricKey === "temperature") return "sensor";
  if (metricKey === "model") return "parse";
  return null;
}

function _mfgSensorColumnsEditHTML(prefix, cols, small) {
  cols = cols || {};
  var map = cols.alarmMap || {};
  var mode = map.mode || "nonzero";
  var html = '<div style="margin-top:4px;font-size:0.7rem;color:var(--color-text-secondary)" title="Used when Type is table: the Symbol above is the value column">Table columns (Type = table):</div>' +
    '<input type="text" class="' + prefix + '-sensorname" value="' + escapeHtml(cols.nameSymbol || "") + '" placeholder="Name column (e.g. fgHwSensorEntName)" ' + small + '>' +
    '<input type="text" class="' + prefix + '-sensoralarm" value="' + escapeHtml(cols.alarmSymbol || "") + '" placeholder="Alarm column (optional)" ' + small + '>' +
    '<div style="display:flex;gap:4px">' +
      '<select class="' + prefix + '-sensoralarmmode" ' + small + ' title="Alarm when the alarm column\'s value…">';
  Object.keys(_MFG_ALARM_MODES).forEach(function (k) {
    html += '<option value="' + k + '"' + (mode === k ? ' selected' : '') + '>alarm: ' + _MFG_ALARM_MODES[k] + '</option>';
  });
  html += '</select>' +
      '<input type="text" class="' + prefix + '-sensoralarmvalues" value="' + escapeHtml((map.values || []).join(", ")) + '" placeholder="values, e.g. 2, 3" ' + small + '>' +
    '</div>' +
    '<div style="display:flex;gap:4px">' +
      '<select class="' + prefix + '-sensorclass" ' + small + ' title="Every row\'s class, for a table whose row names don\'t say">' +
        '<option value="">class: from row name</option>';
  _MFG_SENSOR_CLASSES.forEach(function (c) {
    html += '<option value="' + c + '"' + (cols.sensorClass === c ? ' selected' : '') + '>class: ' + c + '</option>';
  });
  html += '</select>' +
      '<select class="' + prefix + '-sensorscale" ' + small + '>' +
        '<option value="">scale: as read</option>' +
        '<option value="tenths_to_units"' + (cols.transform === "tenths_to_units" ? ' selected' : '') + '>scale: tenths → units</option>' +
      '</select>' +
    '</div>';
  return html;
}

// The columns a row's controls describe, or null when none are set.
function _mfgReadSensorColumns(tr, prefix) {
  var val = function (suffix) { var el = tr.querySelector("." + prefix + "-" + suffix); return el ? (el.value || "").trim() : ""; };
  var nameSymbol  = val("sensorname");
  var alarmSymbol = val("sensoralarm");
  var sensorClass = val("sensorclass");
  var transform   = val("sensorscale");
  if (!nameSymbol && !alarmSymbol && !sensorClass && !transform) return null;
  var values = val("sensoralarmvalues").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    nameSymbol:  nameSymbol || null,
    alarmSymbol: alarmSymbol || null,
    alarmMap:    alarmSymbol ? { mode: val("sensoralarmmode") || "nonzero", values: values } : null,
    sensorClass: sensorClass || null,
    transform:   transform || null,
  };
}

function _mfgExtraEditHTML(metricKey, prefix, vals) {
  var kind = _mfgExtrasFor(metricKey);
  vals = vals || {};
  var small = 'style="width:100%;font-size:0.74rem;margin-top:3px"';
  if (kind === "aggregate") {
    var cur = vals.aggregate || "none";
    var html = '<select class="' + prefix + '-aggregate" ' + small + ' title="How a walked subtree collapses to one reading">';
    ["none", "avg", "sum"].forEach(function (k) {
      html += '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>walk: ' + _MFG_AGGREGATE_LABELS[k] + '</option>';
    });
    return html + '</select>';
  }
  if (kind === "label") {
    return '<input type="text" class="' + prefix + '-label" value="' + escapeHtml(vals.label || "") + '" placeholder="Row label (e.g. flash, System)" ' + small + '>';
  }
  if (kind === "sensor") {
    return '<input type="text" class="' + prefix + '-label" value="' + escapeHtml(vals.label || "") + '" placeholder="Row label for a scalar (e.g. System)" ' + small + '>' +
      _mfgSensorColumnsEditHTML(prefix, vals.sensorColumns, small);
  }
  if (kind === "parse") {
    return '<input type="text" class="' + prefix + '-parsepattern" value="' + escapeHtml(vals.parsePattern || "") + '" placeholder="Parse regex with (capture), e.g. ^(\\S+?)-v\\d" ' + small + '>' +
      '<input type="text" class="' + prefix + '-parsetemplate" value="' + escapeHtml(vals.parseTemplate || "") + '" placeholder="Template with $1, e.g. FortiSwitch $1" ' + small + '>';
  }
  return "";
}

function _mfgExtraViewHTML(metricKey, vals) {
  var kind = _mfgExtrasFor(metricKey);
  vals = vals || {};
  var chip = 'style="display:inline-block;margin-top:3px;font-size:0.7rem;color:var(--color-text-secondary)"';
  if (kind === "aggregate" && vals.aggregate && vals.aggregate !== "none") {
    return '<div ' + chip + '>walk: ' + escapeHtml(_MFG_AGGREGATE_LABELS[vals.aggregate] || vals.aggregate) + '</div>';
  }
  if (kind === "label" && vals.label) {
    return '<div ' + chip + '>label: ' + escapeHtml(vals.label) + '</div>';
  }
  if (kind === "sensor") {
    var c = vals.sensorColumns;
    if (c) {
      var parts = [];
      if (c.nameSymbol) parts.push("name " + c.nameSymbol);
      if (c.alarmSymbol) {
        var m = c.alarmMap || {};
        parts.push("alarm " + c.alarmSymbol + " " + (_MFG_ALARM_MODES[m.mode] || m.mode || "not 0") +
          (m.values && m.values.length ? " " + m.values.join(", ") : ""));
      }
      if (c.sensorClass) parts.push("class " + c.sensorClass);
      if (c.transform === "tenths_to_units") parts.push("tenths → units");
      return '<div ' + chip + '>columns: ' + escapeHtml(parts.join(" · ")) + '</div>';
    }
    if (vals.label) return '<div ' + chip + '>label: ' + escapeHtml(vals.label) + '</div>';
  }
  if (kind === "parse" && (vals.parsePattern || vals.parseTemplate)) {
    return '<div ' + chip + '>parse: <code>' + escapeHtml(vals.parsePattern || "") + '</code>' +
      (vals.parseTemplate ? ' → <code>' + escapeHtml(vals.parseTemplate) + '</code>' : '') + '</div>';
  }
  return "";
}

// Read the extras back out of a row for the save payload. Absent controls
// (a metric with no extras) come back null / "none", which the server treats
// as "leave as is" on the fields it does not own.
function _mfgReadExtras(tr, prefix, metricKey) {
  var kind = _mfgExtrasFor(metricKey);
  var val = function (suffix) { var el = tr.querySelector("." + prefix + "-" + suffix); return el ? (el.value || "").trim() : ""; };
  return {
    aggregate:     kind === "aggregate" ? (val("aggregate") || "none") : "none",
    label:         (kind === "label" || kind === "sensor") ? (val("label") || null) : null,
    parsePattern:  kind === "parse"     ? (val("parsepattern") || null) : null,
    parseTemplate: kind === "parse"     ? (val("parsetemplate") || null) : null,
    sensorColumns: kind === "sensor"    ? _mfgReadSensorColumns(tr, prefix) : null,
  };
}

// ─── Readiness rendering ────────────────────────────────────────────────
//
// The server stamps every configured profile row with `readiness` — did the
// symbol resolve at this manufacturer's scope, via which module and layer,
// and if not, what to upload (`hint.kind === "imports"` names the module the
// pinned MIB is missing; `"no-module"` means nothing loaded defines it). The
// MIB cell renders THAT, so the page can never claim a row works when it
// does not. An unconfigured row (no symbol) has no readiness and shows the
// operator's pin as before.

var _MFG_SCOPE_LABELS = {
  device:   "device MIB",
  vendor:   "vendor MIB",
  generic:  "generic MIB",
  standard: "shipped standard",
  seed:     "built-in seed",
};

function _mfgReadinessHint(r) {
  if (!r || r.resolved) return "";
  if (r.hint && r.hint.kind === "imports") {
    var mods = [];
    (r.hint.roots || []).forEach(function (x) {
      var m = x.module || x.symbol;
      if (mods.indexOf(m) === -1) mods.push(m);
    });
    return escapeHtml(r.hint.mibModuleName) + " is missing " + mods.map(escapeHtml).join(", ") + " — upload it too";
  }
  return "no uploaded MIB defines " + escapeHtml(r.symbol) + " — upload the vendor’s MIB";
}

// One MIB cell. `readiness` is `{ a, b }` (b for the second symbol of a
// double_scalar row) or null/undefined for an unconfigured row.
function _mfgMibCellHTML(readiness, mibId, mibStdKey) {
  if (!readiness) {
    // Unconfigured: show the pin the operator made, or that the built-in
    // seed answers.
    var stdLabel = mibStdKey ? STD_MIB_LABELS[mibStdKey] : null;
    if (mibId)    return '<span style="font-size:0.78rem">' + escapeHtml(_mfgLookupMibLabel(mibId)) + '</span>';
    if (stdLabel) return '<span style="font-size:0.78rem">' + escapeHtml(stdLabel) + '</span>';
    return '<span style="font-size:0.78rem;color:var(--color-text-tertiary);font-style:italic">seed</span>';
  }
  var parts = [readiness.a];
  if (readiness.b) parts.push(readiness.b);
  var bad = parts.filter(function (r) { return r && !r.resolved; });
  if (bad.length === 0) {
    var r0 = readiness.a;
    var mod = r0.fromModuleName || (r0.fromScope === "seed" ? "built-in seed" : "(resolved)");
    var scope = _MFG_SCOPE_LABELS[r0.fromScope] || r0.fromScope || "";
    // Both symbols of a pair normally come from one module; say so once, and
    // name the second only when it differs.
    var second = readiness.b && readiness.b.fromModuleName && readiness.b.fromModuleName !== r0.fromModuleName
      ? ' <span style="color:var(--color-text-tertiary)">+ ' + escapeHtml(readiness.b.fromModuleName) + '</span>' : '';
    return '<span style="font-size:0.78rem" title="' + escapeHtml(r0.oid || "") + '">' +
      escapeHtml(mod) + second +
      (scope ? ' <span style="color:var(--color-text-tertiary);font-size:0.72rem">(' + escapeHtml(scope) + ')</span>' : '') +
    '</span>';
  }
  var hints = [];
  bad.forEach(function (r) { var h = _mfgReadinessHint(r); if (h && hints.indexOf(h) === -1) hints.push(h); });
  return '<span style="font-size:0.78rem;color:var(--color-danger)" title="' + hints.join("\n") + '">' +
    '⚠ unresolved' +
    '<span style="display:block;font-size:0.72rem;color:var(--color-text-secondary)">' + hints.join("<br>") + '</span>' +
  '</span>';
}

// Collapsed-header pill: green "ready" when every configured symbol resolves,
// amber with a count otherwise. Nothing when the profile configures no
// symbols at all (a fresh, empty profile is neither).
function _mfgReadinessPillHTML(p) {
  if (!p || (!p.ready && !p.partial && !(p.unresolvedCount > 0))) return "";
  if (p.ready) {
    return ' <span style="font-size:0.7rem;font-weight:600;letter-spacing:0.04em;color:var(--color-success);margin-left:6px" title="Every configured symbol resolves">READY</span>';
  }
  var n = p.unresolvedCount || 0;
  var tip = (p.unresolvedSymbols || []).join(", ");
  return ' <span style="font-size:0.7rem;font-weight:600;letter-spacing:0.04em;color:var(--color-warning,#d97706);margin-left:6px" title="' + escapeHtml(tip) + '">' +
    n + ' UNRESOLVED</span>';
}

// The upload form's inline result: stored + usable, or stored + what to add.
function _mibUploadResultHTML(created) {
  if (!created || typeof created.symbolCount !== "number") return "";
  var total = created.symbolCount;
  var bad = created.unresolvedCount || 0;
  if (bad === 0) {
    return '<span style="color:var(--color-success)">' + escapeHtml(created.moduleName) + ': ' + total + ' symbol' + (total === 1 ? '' : 's') + ', all resolve.</span>';
  }
  var roots = Array.isArray(created.unresolvedRoots) ? created.unresolvedRoots : [];
  var mods = [];
  roots.forEach(function (r) { var m = r.module || r.symbol; if (mods.indexOf(m) === -1) mods.push(m); });
  return '<span style="color:var(--color-warning,#d97706)">' + escapeHtml(created.moduleName) + ': ' + bad + ' of ' + total + ' symbol' + (total === 1 ? '' : 's') + ' unresolved' +
    (mods.length > 0 ? ' — needs <b>' + mods.map(escapeHtml).join("</b>, <b>") + '</b>; upload ' + (mods.length === 1 ? 'it' : 'them') + ' too.' : '.') +
  '</span>';
}

// Toast every warning a write came back with. The write SUCCEEDED — these
// say the row names a symbol nothing resolves yet.
function _mfgToastWarnings(resp) {
  var w = resp && Array.isArray(resp.warnings) ? resp.warnings : [];
  w.forEach(function (msg) { showToast(msg, "warning"); });
}

// Map a MibFile.id back to its module name (or a short fallback) for the
// MIB column. Reads the same `_mibsData` cache the dropdown is populated
// from, so a freshly uploaded MIB shows up immediately on next render.
function _mfgLookupMibLabel(mibId) {
  for (var i = 0; i < _mibsData.length; i++) {
    if (_mibsData[i].id === mibId) {
      return _mibsData[i].moduleName || _mibsData[i].filename || "(MIB)";
    }
  }
  return "(deleted MIB)";
}

// Metric-row Type select: scalar | double_scalar | table.
function renderTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "double_scalar", "table"]);
}
// Custom-widget Symbol-Type select: scalar | table only (widget renderer
// has no combiner support).
function renderWidgetTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "table"]);
}

// Transform / Combiner select. `type` decides which list to render:
//   "double_scalar" → binary combiners (CombinerKind on the backend)
//   anything else   → unary transforms (TransformKind)
// `metricKey` is passed by metric rows and overrides, never by widgets: it
// narrows the unary list to what that metric's collector applies
// (_mfgMetricTransforms), and a metric with nothing applicable gets a plain
// "—" instead of a select. With no select in the row the save handlers read
// an empty value, so saving also clears a stale transform.
function renderTransformSelect(current, cls, type, metricKey) {
  var list = type === "double_scalar" ? _mfgProfileCombiners : _mfgProfileTransforms;
  if (metricKey && type !== "double_scalar") {
    var allowed = type === "scalar" ? (_mfgMetricTransforms[metricKey] || []) : [];
    list = list.filter(function (t) { return allowed.indexOf(t.kind) !== -1; });
    if (!list.length) {
      return '<span class="' + cls + '-none" style="font-size:0.78rem;color:var(--color-text-tertiary)">—</span>';
    }
  }
  var html = '<select class="' + cls + '" style="font-size:0.78rem">' +
    '<option value="">— none —</option>';
  list.forEach(function (t) {
    html += '<option value="' + escapeHtml(t.kind) + '"' + (current === t.kind ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
  });
  html += '</select>';
  return html;
}

// Symbol picker that depends on the MIB selection. When mibId is empty
// (= "Built-in seed"), Polaris doesn't have a symbol list to draw from
// — every seeded symbol lives in oidRegistry without an enumerable
// directory. So we fall through to a free-text input the operator types
// into. When mibId is set AND the structure has been fetched + cached,
// we render a `<select>` populated with that MIB's readable symbol
// names. While the structure is in flight we render a disabled select
// with "Loading…" so the operator sees the chain react.
function renderSymbolPicker(currentSymbol, mibId, cls, type) {
  // Only "Built-in seed" (empty) falls back to free text — the seed is a
  // handful of SMI root arcs with no directory to list. A standard MIB pick
  // (std:*) enumerates like an upload does, through GET /mibs/std/:key/
  // structure, which returns the same shape as the uploaded variant.
  if (!mibId) {
    return '<input type="text" class="' + cls + '" value="' + escapeHtml(currentSymbol || "") +
      '" placeholder="Symbol (e.g. fgSysCpuUsage)" style="width:100%;font-size:0.78rem">';
  }
  var entry = _mfgMibSymbolsCache[mibId];
  if (!entry || entry.loading) {
    // Fire the fetch (idempotent) and render a placeholder. The change
    // listener that triggered this re-render kicks off the load; once
    // it completes the helper re-renders the tab and the dropdown
    // populates.
    _ensureMibSymbols(mibId);
    return '<select class="' + cls + '" disabled style="width:100%;font-size:0.78rem">' +
      '<option>Loading symbols…</option>' +
    '</select>';
  }
  // Pick which side of the split to surface. `type === "table"` shows the
  // table-row OIDs (each one walks to a 2D result); anything else (scalar
  // is the default) shows the scalar/leaf symbols. Memory's multi-OID
  // picker still passes no type and gets the scalars list, matching its
  // pre-split behaviour.
  var names = (type === "table") ? (entry.tables || []) : (entry.scalars || []);
  // A type-to-filter combobox rather than a <select>: a vendor MIB carries
  // hundreds to thousands of symbols (PowerNet-MIB alone is ~3 MB), too many
  // to scroll. The list lives in _mfgMibSymbolsCache, so the markup carries
  // only the MIB id + side; the delegated handlers below filter it. The
  // saved symbol rides along as data-initial so a value not in the chosen
  // list (a table symbol after flipping Type to scalar) still round-trips
  // while the operator decides — what the old "(not a scalar)" option did.
  var side = type === "table" ? "table" : "scalar";
  var unknown = currentSymbol && names.indexOf(currentSymbol) === -1;
  return '<span class="aw-combo aw-combo-dim">' +
    '<input type="text" class="' + cls + ' mib-sym-combo" autocomplete="off" spellcheck="false"' +
      ' data-mib-id="' + escapeHtml(mibId) + '" data-sym-side="' + side + '"' +
      ' data-initial="' + escapeHtml(currentSymbol || "") + '"' +
      ' value="' + escapeHtml(currentSymbol || "") + '"' +
      ' placeholder="Type to filter ' + names.length + ' ' + side + ' symbol' + (names.length === 1 ? "" : "s") + '"' +
      (unknown ? ' title="Not a ' + side + ' in this MIB"' : '') +
      ' style="width:100%;font-size:0.78rem' + (unknown ? ';border-color:var(--color-danger)' : '') + '">' +
    '<div class="aw-suggest"></div>' +
  '</span>';
}

// ─── Symbol combobox (delegated) ───────────────────────────────────────────
// One set of document-level handlers serves every Symbol picker the
// Manufacturer Profiles card renders (metric rows, overrides, widgets), so the
// card's many re-renders never need to re-wire anything.

var _SYM_COMBO_LIMIT = 200;

function _symComboNames(input) {
  var entry = _mfgMibSymbolsCache[input.getAttribute("data-mib-id")];
  if (!entry || entry.loading) return null;
  return input.getAttribute("data-sym-side") === "table" ? (entry.tables || []) : (entry.scalars || []);
}

/** True when `value` is one this picker would accept on its own: a symbol in
 *  its list, or the saved value it was rendered with. A restore after a MIB or
 *  Type swap drops anything else — what a <select> did by itself. */
function _symComboAccepts(input, value) {
  if (!value) return true;
  if (value === input.getAttribute("data-initial")) return true;
  var names = _symComboNames(input);
  return !!names && names.indexOf(value) !== -1;
}

function _symComboMarkUnknown(input) {
  var v = (input.value || "").trim();
  var names = _symComboNames(input);
  var bad = !!(v && names && names.indexOf(v) === -1);
  input.style.borderColor = bad ? "var(--color-danger)" : "";
  input.title = bad ? "Not a " + input.getAttribute("data-sym-side") + " in this MIB" : "";
}

function _renderSymCombo(input) {
  var box = input.nextElementSibling;
  var names = _symComboNames(input);
  if (!box || !names) return;
  var q = (input.value || "").trim().toLowerCase();
  // Prefix matches first (an exact match among them, leading), then interior.
  // The exact match stays listed so a complete, correct name reads as found
  // rather than as "no symbol matches".
  var prefix = [], interior = [];
  names.forEach(function (n) {
    var v = n.toLowerCase();
    if (q && v === q) { prefix.unshift(n); return; }
    var at = q ? v.indexOf(q) : 0;
    if (at === 0) prefix.push(n);
    else if (at > 0) interior.push(n);
  });
  var matches = prefix.concat(interior);
  if (!matches.length) {
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (q ? "No symbol in this MIB matches." : "This MIB has no symbols of this type.") + '</div>';
  } else {
    box.innerHTML = matches.slice(0, _SYM_COMBO_LIMIT).map(function (n) {
      return '<div class="aw-suggest-item" data-val="' + escapeHtml(n) + '">' + escapeHtml(n) + '</div>';
    }).join("") +
      (matches.length > _SYM_COMBO_LIMIT
        ? '<div class="aw-suggest-empty">' + (matches.length - _SYM_COMBO_LIMIT) + ' more — keep typing to narrow</div>'
        : "");
  }
  box.classList.add("open");
}

function _pickSymCombo(input, value) {
  input.value = value;
  _closeMfgSuggest(input.nextElementSibling);
  _symComboMarkUnknown(input);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

document.addEventListener("focusin", function (e) {
  if (e.target.classList && e.target.classList.contains("mib-sym-combo")) _renderSymCombo(e.target);
});
document.addEventListener("click", function (e) {
  if (e.target.classList && e.target.classList.contains("mib-sym-combo")) _renderSymCombo(e.target);
});
document.addEventListener("input", function (e) {
  if (!e.target.classList || !e.target.classList.contains("mib-sym-combo")) return;
  _renderSymCombo(e.target);
  _symComboMarkUnknown(e.target);
});
document.addEventListener("focusout", function (e) {
  var input = e.target;
  if (!input.classList || !input.classList.contains("mib-sym-combo")) return;
  // Delay so a mousedown on an item (which fires before blur completes) lands.
  setTimeout(function () { _closeMfgSuggest(input.nextElementSibling); }, 150);
});
document.addEventListener("mousedown", function (e) {
  var item = e.target.closest && e.target.closest(".aw-suggest-item");
  var input = item && item.parentElement && item.parentElement.previousElementSibling;
  if (!input || !input.classList.contains("mib-sym-combo")) return;
  e.preventDefault(); // keep focus on the input
  _pickSymCombo(input, item.getAttribute("data-val"));
});
document.addEventListener("keydown", function (e) {
  var input = e.target;
  if (!input.classList || !input.classList.contains("mib-sym-combo")) return;
  var box = input.nextElementSibling;
  if (!box || !box.classList.contains("open")) return;
  if (e.key === "Escape") { _closeMfgSuggest(box); e.stopPropagation(); return; }
  var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
  var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    items.forEach(function (i) { i.classList.remove("active"); });
    items[next].classList.add("active");
    if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    // Enter never submits the row from here: a highlighted (or the only)
    // match completes the box, and the Save button stays the one way to save.
    e.preventDefault();
    var pick = idx >= 0 ? items[idx] : (items.length === 1 ? items[0] : null);
    if (pick) _pickSymCombo(input, pick.getAttribute("data-val"));
  }
});

// Lazy-fetch + cache one MIB's symbol list, split into `tables` vs
// `scalars` so the per-row Symbol picker can populate from whichever
// list matches the operator's chosen Type. Mirrors the Browse modal's
// split: tables come from `struct.tables[]`, scalars are every other
// symbol that isn't a table column, table row, or table name.
// Re-render happens once the fetch resolves so the disabled "Loading…"
// state in the picker swaps to the populated dropdown.
function _ensureMibSymbols(mibId) {
  if (!mibId) return;
  if (_mfgMibSymbolsCache[mibId] && !_mfgMibSymbolsCache[mibId].loading) return;
  if (_mfgMibSymbolsCache[mibId] && _mfgMibSymbolsCache[mibId].loading) return; // already in flight
  _mfgMibSymbolsCache[mibId] = { loading: true, scalars: [], tables: [] };
  // A std:* key has no MibFile row; its structure comes from the bundled
  // module via the std route. Same response shape, same split below.
  var isStd = typeof mibId === "string" && mibId.indexOf("std:") === 0;
  var fetchStructure = isStd
    ? api.serverSettings.getStdMibStructure(mibId)
    : api.serverSettings.getMibStructure(mibId);
  fetchStructure.then(function (struct) {
    var tables = (struct.tables || []).map(function (t) { return t.name; }).filter(Boolean);
    // Build "everything that isn't a table-related symbol" for the scalar list.
    var tableColumns = new Set();
    var tableRows    = new Set();
    var tableNames   = new Set(tables);
    (struct.tables || []).forEach(function (t) {
      if (t.rowSymbol) tableRows.add(t.rowSymbol);
      (t.columns || []).forEach(function (c) { tableColumns.add(c); });
    });
    var scalars = (struct.symbols || [])
      .map(function (s) { return s.name; })
      .filter(function (n) {
        return n && !tableColumns.has(n) && !tableRows.has(n) && !tableNames.has(n);
      });
    // A table row walks either the whole table or one of its columns — the
    // sensor-column shape (fgHwSensorEntValue beside fgHwSensorEntName) names
    // the value column — so both belong on the Table side, or a correct column
    // pick is flagged "Not a table in this MIB".
    tables = tables.concat(Array.from(tableColumns));
    // De-dupe + sort so both dropdowns are predictable.
    tables  = Array.from(new Set(tables)).sort(function (a, b) { return a.localeCompare(b); });
    scalars = Array.from(new Set(scalars)).sort(function (a, b) { return a.localeCompare(b); });
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: scalars, tables: tables };
    // Preserving, not bare: this lands after the picking handler's own restore,
    // so a bare re-render re-erases everything the operator typed.
    _mfgRerenderPreservingAll();
  }).catch(function (err) {
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: [], tables: [] };
    showToast(err.message || "Failed to load MIB symbols", "error");
    _mfgRerenderPreservingAll();
  });
}

// Dropdown of MIBs available to symbol resolution at this manufacturer's
// scope. Three groups, in order:
//   1) Standard MIBs (RFC / IEEE specs Polaris ships seeded OIDs for) — the
//      `std:*` keys. Display-only at probe time; the value persists into
//      `defaultMibStdKey` so the MIB column shows a meaningful label.
//   2) Vendor MIBs — uploaded MIBs whose `manufacturer` matches this profile
//      (case-insensitive). Mirrors `oidRegistry`'s vendor-scope pass.
//   3) Generic MIBs — uploaded MIBs with `manufacturer = null`. The
//      resolver consults these at the generic tier for every vendor.
//
// `currentSelection` is the combined dropdown value (see joinMibSelection):
// "" = built-in seed, "std:*" = standard MIB key, UUID = uploaded MIB.
// `omitSeed=true` hides the "Built-in seed" placeholder so the add-row
// dropdown shows only real options (an empty-on-submit value still
// round-trips to mibId=null on the server side).
function renderMibSelect(currentSelection, cls, manufacturer, omitSeed) {
  var current = currentSelection || "";
  var mfg = (manufacturer || "").toLowerCase();
  var vendorScoped = (_mibsData || []).filter(function (m) {
    return (m.manufacturer || "").toLowerCase() === mfg;
  });
  var generic = (_mibsData || []).filter(function (m) {
    return !m.manufacturer;
  });
  var html = '<select class="' + cls + '" style="font-size:0.78rem">';
  if (omitSeed) {
    if (!current) {
      html += '<option value="" selected disabled>— select MIB —</option>';
    }
  } else {
    html += '<option value=""' + (!current ? " selected" : "") + '>Built-in seed</option>';
  }
  // Standard MIBs optgroup
  html += '<optgroup label="Standard MIBs">';
  STD_MIB_ORDER.forEach(function (key) {
    html += '<option value="' + escapeHtml(key) + '"' +
      (current === key ? " selected" : "") + '>' +
      escapeHtml(STD_MIB_LABELS[key]) +
    '</option>';
  });
  html += '</optgroup>';
  // Vendor MIBs optgroup (only when this profile has any vendor-scoped uploads)
  if (vendorScoped.length) {
    html += '<optgroup label="Vendor MIBs">';
    vendorScoped.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      if (m.model) label += " (" + m.model + ")";
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  // Generic MIBs optgroup (only when at least one uploaded MIB has no manufacturer)
  if (generic.length) {
    html += '<optgroup label="Generic MIBs">';
    generic.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  html += '</select>';
  return html;
}

function transformLabel(kind) {
  for (var i = 0; i < _mfgProfileTransforms.length; i++) {
    if (_mfgProfileTransforms[i].kind === kind) return _mfgProfileTransforms[i].label;
  }
  // Fall through to combiners (double_scalar) — same lookup pattern; same
  // result if the kind isn't a recognized combiner either.
  for (var j = 0; j < _mfgProfileCombiners.length; j++) {
    if (_mfgProfileCombiners[j].kind === kind) return _mfgProfileCombiners[j].label;
  }
  return kind;
}

function wireManufacturerProfileControls() {
  var addBtn = document.getElementById("btn-add-mfg-profile");
  if (addBtn) addBtn.addEventListener("click", addManufacturerProfile);
  var importBtn = document.getElementById("btn-import-mfg-profile");
  var importFile = document.getElementById("f-import-mfg-profile");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", function () { importFile.value = ""; importFile.click(); });
    importFile.addEventListener("change", function () {
      if (importFile.files && importFile.files[0]) openProfileImportModal(importFile.files[0]);
    });
  }

  wireManufacturerSuggestCombo();

  var list = document.getElementById("mfg-profiles-list");
  if (!list) return;

  // Delegated click handler — one listener covers every row, every edit
  // button, every save/cancel, override add/delete, profile delete.
  list.addEventListener("click", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    var delBtn = target.closest(".mfg-profile-del");
    if (delBtn) { e.stopPropagation(); return deleteManufacturerProfile(delBtn.getAttribute("data-id")); }
    var codeBtn = target.closest(".mfg-profile-code");
    if (codeBtn) { e.stopPropagation(); return openProfileCodeModal(codeBtn.getAttribute("data-id")); }

    var header = target.closest(".mfg-profile-header");
    if (header) return toggleProfileExpand(header.parentElement.getAttribute("data-profile-id"));

    var matchSaveBtn = target.closest(".mfg-matchpattern-save");
    if (matchSaveBtn) return saveMatchPattern(matchSaveBtn);

    var editBtn = target.closest(".mfg-metric-edit");
    if (editBtn) return beginMetricEdit(editBtn.closest("tr"));

    var saveBtn = target.closest(".mfg-metric-save");
    if (saveBtn) return saveMetricEdit(saveBtn.closest("tr"));

    var cancelBtn = target.closest(".mfg-metric-cancel");
    if (cancelBtn) return cancelMetricEdit(cancelBtn.closest("tr"));

    var addOpenBtn = target.closest(".mfg-override-add-open");
    if (addOpenBtn) return toggleOverrideAdd(addOpenBtn.closest("tr"), true);

    var addCancelBtn = target.closest(".mfg-override-add-cancel");
    if (addCancelBtn) return toggleOverrideAdd(addCancelBtn.closest("tr"), false);

    var addOverBtn = target.closest(".mfg-override-add");
    if (addOverBtn) return addOverride(addOverBtn.closest("tr"));

    var delOverBtn = target.closest(".mfg-override-del");
    if (delOverBtn) return deleteOverride(delOverBtn.closest("tr"));

    var editOverBtn = target.closest(".mfg-override-edit");
    if (editOverBtn) return beginOverrideEdit(editOverBtn.closest("tr"));

    var saveOverBtn = target.closest(".mfg-override-save");
    if (saveOverBtn) return saveOverrideEdit(saveOverBtn.closest("tr"));

    var cancelOverBtn = target.closest(".mfg-override-cancel");
    if (cancelOverBtn) return cancelOverrideEdit(cancelOverBtn.closest("tr"));

    // ─── Widget click handlers ─────────────────────────────────────────
    var addWidgetToggleBtn = target.closest(".mfg-widget-add-toggle");
    if (addWidgetToggleBtn) {
      var pidAdd = addWidgetToggleBtn.getAttribute("data-profile-id");
      _mfgAddingWidget[pidAdd] = true;
      renderIdentificationTab();
      return;
    }
    var widgetEditBtn = target.closest(".mfg-widget-edit");
    if (widgetEditBtn) {
      var cardEdit = widgetEditBtn.closest(".mfg-widget-card");
      if (cardEdit) {
        _mfgWidgetEdit[cardEdit.getAttribute("data-widget-id")] = true;
        renderIdentificationTab();
      }
      return;
    }
    var widgetSaveBtn = target.closest(".mfg-widget-save");
    if (widgetSaveBtn) return saveWidgetEdit(widgetSaveBtn.closest(".mfg-widget-edit-card"));
    var widgetCancelBtn = target.closest(".mfg-widget-cancel");
    if (widgetCancelBtn) {
      var cardC = widgetCancelBtn.closest(".mfg-widget-edit-card");
      if (cardC) {
        var wid = cardC.getAttribute("data-widget-id");
        delete _mfgWidgetEdit[wid];
        _mfgWidgetClearShadow("widget:" + wid);
        renderIdentificationTab();
      }
      return;
    }
    var widgetAddSaveBtn = target.closest(".mfg-widget-add-save");
    if (widgetAddSaveBtn) return saveNewWidget(widgetAddSaveBtn.closest(".mfg-widget-add-card"));
    var widgetAddCancelBtn = target.closest(".mfg-widget-add-cancel");
    if (widgetAddCancelBtn) {
      var cardAC = widgetAddCancelBtn.closest(".mfg-widget-add-card");
      if (cardAC) {
        var pidAC = cardAC.getAttribute("data-profile-id");
        delete _mfgAddingWidget[pidAC];
        _mfgWidgetClearShadow("new-widget:" + pidAC);
        renderIdentificationTab();
      }
      return;
    }
    var widgetDevBtn = target.closest(".mfg-widget-devices");
    if (widgetDevBtn) {
      var cardDev = widgetDevBtn.closest(".mfg-widget-card");
      if (!cardDev) return;
      var pidDev = cardDev.getAttribute("data-profile-id");
      var widDev = cardDev.getAttribute("data-widget-id");
      var prof = (_mfgProfileDetail && _mfgProfileDetail[pidDev]) || null;
      var wDef = prof && (prof.widgets || []).find(function (x) { return x.id === widDev; });
      return openWidgetDevicesModal(pidDev, wDef || { id: widDev, name: "widget" }, false);
    }
    var widgetDelBtn = target.closest(".mfg-widget-del");
    if (widgetDelBtn) {
      var cardDel = widgetDelBtn.closest(".mfg-widget-card");
      if (cardDel) return deleteWidget(cardDel.getAttribute("data-profile-id"), cardDel.getAttribute("data-widget-id"));
      return;
    }
  });

  // The chained MIB → Symbol pickers need a `change` listener separate
  // from the click delegation above. When the operator changes any of
  // the three MIB selects in this card, stash the new value into the
  // edit-state map and re-render so the symbol picker swaps from text
  // input (seed) to dropdown (MIB-driven), or to a different MIB's symbol
  // list. _ensureMibSymbols pre-warms the cache so the dropdown is ready.
  list.addEventListener("change", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    if (target.classList.contains("mfg-edit-mib")) {
      var tr = target.closest("tr");
      if (!tr) return;
      var key = "metric:" + tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key");
      _mfgEditMibSelections[key] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-mib")) {
      var tr2 = target.closest("tr");
      if (!tr2) return;
      _mfgEditMibSelections["override:" + tr2.getAttribute("data-override-id")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-mib")) {
      var tr3 = target.closest("tr");
      if (!tr3) return;
      _mfgEditMibSelections["new:" + tr3.getAttribute("data-profile-id") + ":" + tr3.getAttribute("data-metric-key")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    // Type selectors — flipping scalar / double_scalar / table re-renders
    // both the Symbol cell (1 or 2 pickers) AND the Transform select (unary
    // transforms vs binary combiners). Three flavours: metric-row edit,
    // override-row edit, add-override row.
    if (target.classList.contains("mfg-edit-type")) {
      var trType = target.closest("tr");
      if (!trType) return;
      _mfgEditTypeSelections["metric:" + trType.getAttribute("data-profile-id") + ":" + trType.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-type")) {
      var trTypeOv = target.closest("tr");
      if (!trTypeOv) return;
      _mfgEditTypeSelections["override:" + trTypeOv.getAttribute("data-override-id")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-type")) {
      var trTypeNew = target.closest("tr");
      if (!trTypeNew) return;
      _mfgEditTypeSelections["new:" + trTypeNew.getAttribute("data-profile-id") + ":" + trTypeNew.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // ─── Widget MIB / Type / WidgetType selects ───────────────────────
    // The widget card hosts THREE chained selects (MIB → symbol Type →
    // Symbol picker; plus a parallel WidgetType select that drives the
    // displayOptions sub-form). They share these class names with the
    // metric-row controls, so first resolve which card they live in
    // before falling through to the metric handlers above… actually
    // the widget-card classes are unique (mfg-widget-mib etc.) so this
    // is straight-through.
    // State-probe mode: only some modes take comparison values. Toggled IN PLACE
    // rather than through renderIdentificationTab() — a re-render rebuilds the
    // card from the stored widget, which would discard whatever the operator has
    // typed into the other mapping fields.
    if (target.classList.contains("mfg-widget-statemode")) {
      var cardSM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardSM) return;
      var valsEl = cardSM.querySelector(".mfg-widget-statevalues");
      if (valsEl) valsEl.disabled = STATE_MODES_WITH_VALUES.indexOf(target.value) === -1;
      return;
    }
    if (target.classList.contains("mfg-widget-mib")) {
      var cardWM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWM) return;
      var keyWM = _widgetCardKey(cardWM);
      _mfgWidgetEditMib[keyWM] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-widget-type")) {
      var cardWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWT) return;
      _mfgWidgetEditType[_widgetCardKey(cardWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // Port controls on an http widget. Handled here rather than by a re-render
    // because nothing about the payload changes — only whether the field is
    // editable and which default its placeholder names.
    if (target.classList.contains("mfg-http-customport") || target.classList.contains("mfg-http-https")) {
      var cardHP = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardHP) return;
      var cpBox = cardHP.querySelector(".mfg-http-customport");
      var tlsBox = cardHP.querySelector(".mfg-http-https");
      var pInput = cardHP.querySelector(".mfg-http-port");
      if (cpBox && pInput) {
        pInput.disabled = !cpBox.checked;
        pInput.style.opacity = cpBox.checked ? "" : "0.5";
        pInput.placeholder = "default (" + (tlsBox && tlsBox.checked ? "443" : "80") + ")";
      }
      return;
    }
    if (target.classList.contains("mfg-widget-widgettype")) {
      var cardWWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWWT) return;
      _mfgWidgetEditWidgetType[_widgetCardKey(cardWWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
  });
}

// Derive the widget-shadow-store key from an edit or add card element.
function _widgetCardKey(cardEl) {
  if (!cardEl) return "";
  if (cardEl.classList.contains("mfg-widget-edit-card")) {
    return "widget:" + cardEl.getAttribute("data-widget-id");
  }
  return "new-widget:" + cardEl.getAttribute("data-profile-id");
}

// ─── Preserving typed input across a chained-select re-render ───────────────
//
// The MIB / symbol-type / widget-type selects are chained: changing one changes
// what the dependent controls offer (Symbol comes from the MIB, the sub-form
// from the widget type), so each handler re-renders. But the re-render rebuilds
// every row and card from STORED state, and the only things carried across were
// the three selects themselves — so an operator who typed a Name and then
// picked a MIB watched the Name vanish. Every field was affected, on the metric
// rows and override rows as much as the widget card.
//
// Rather than a shadow store per field (nine handlers × a growing set of
// fields), snapshot the editing container's live control values, re-render, then
// write them back. Keyed on the same identity the handlers already use, so the
// values can't land in a different row. A `<select>` whose options changed drops
// a value the new list doesn't offer — which is what should happen to a Symbol
// after its MIB is swapped.

/** The editing container an element belongs to (widget card or table row). */
function _mfgEditContainerOf(el) {
  if (!el || !el.closest) return null;
  return el.closest(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr");
}

/** Stable identity for a container, matching the handlers' shadow-store keys so
 *  a snapshot is restored into the same row it came from. */
function _mfgEditContainerKey(container) {
  if (!container) return "";
  if (container.classList.contains("mfg-widget-edit-card") ||
      container.classList.contains("mfg-widget-add-card")) {
    return _widgetCardKey(container);
  }
  // The profile's "also applies when" box is a per-profile editor with no
  // metric key — an unsaved pattern must survive a re-render kicked off by
  // any row below it, so it gets its own container identity.
  if (container.classList.contains("mfg-profile-scope")) {
    return "profile:" + container.getAttribute("data-profile-id");
  }
  var ovr = container.getAttribute("data-override-id");
  if (ovr) return "override:" + ovr;
  var pid = container.getAttribute("data-profile-id");
  var mk = container.getAttribute("data-metric-key");
  if (!pid || !mk) return "";
  // A metric row and the "add override" row beneath it share profile+metricKey;
  // the controls each one owns are what tell them apart.
  var isNew = !!container.querySelector(".mfg-new-override-mib, .mfg-new-override-type, .mfg-new-override-symbol");
  return (isNew ? "new:" : "metric:") + pid + ":" + mk;
}

/** The field's snapshot key — its own `mfg-*` class, which is unique per
 *  control within a container. */
function _mfgFieldKey(el) {
  var cls = (el.className || "").split(/\s+/);
  for (var i = 0; i < cls.length; i++) {
    if (cls[i].indexOf("mfg-") === 0) return cls[i];
  }
  return "";
}

function _mfgSnapshotFields(container) {
  var vals = {};
  if (!container) return vals;
  container.querySelectorAll("input, select, textarea").forEach(function (el) {
    var key = _mfgFieldKey(el);
    if (!key) return;
    vals[key] = (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
  });
  return vals;
}

/**
 * Re-render the Identification tab without losing what the operator has typed
 * into the row/card that triggered it. Use this instead of a bare
 * renderIdentificationTab() from any chained-control handler.
 */
function _mfgRerenderPreserving(el) {
  var container = _mfgEditContainerOf(el);
  var key = _mfgEditContainerKey(container);
  var vals = _mfgSnapshotFields(container);
  renderIdentificationTab();
  if (!key || !Object.keys(vals).length) return;
  var snap = {};
  snap[key] = vals;
  _mfgRestoreEditors(snap);
}

/** Every open editing container's live values, keyed by container identity. */
function _mfgSnapshotAllEditors() {
  var snap = {};
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var key = _mfgEditContainerKey(c);
      if (!key) return;
      var vals = _mfgSnapshotFields(c);
      if (Object.keys(vals).length) snap[key] = vals;
    });
  return snap;
}

/** Write a snapshot back into whichever containers now carry those keys. */
function _mfgRestoreEditors(snap) {
  if (!snap) return;
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var vals = snap[_mfgEditContainerKey(c)];
      if (!vals) return;
      c.querySelectorAll("input, select, textarea").forEach(function (field) {
        var fk = _mfgFieldKey(field);
        if (!fk || !(fk in vals)) return;
        if (field.type === "checkbox" || field.type === "radio") { field.checked = !!vals[fk]; return; }
        // A <select> whose options changed drops a value the new list doesn't
        // offer — which is what should happen to a Symbol after a MIB swap.
        // The Symbol combobox is a text box, so it is told to do the same.
        if (field.classList.contains("mib-sym-combo") && !_symComboAccepts(field, vals[fk])) return;
        field.value = vals[fk];
        if (field.classList.contains("mib-sym-combo")) _symComboMarkUnknown(field);
      });
    });
}

/**
 * Re-render preserving EVERY open editor, for a re-render with no triggering
 * element to key from — specifically the ASYNCHRONOUS one.
 *
 * `_mfgRerenderPreserving` above fixes the re-render a chained select performs
 * synchronously, but picking a MIB also kicks off `_ensureMibSymbols`, whose
 * fetch re-renders again when it resolves. That second render lands AFTER the
 * restore, from a callback that never saw the element, so on a cache miss — i.e.
 * every first pick of a MIB, the reported case — the operator watched the Name
 * come back and then vanish again a few hundred ms later. Snapshotting all open
 * editors is what lets a callback with no context put them back.
 */
function _mfgRerenderPreservingAll() {
  var snap = _mfgSnapshotAllEditors();
  renderIdentificationTab();
  _mfgRestoreEditors(snap);
}

// ─── "+ Add Manufacturer" typeahead ────────────────────────────────────────
// The box stays free text — any custom vendor is accepted. The dropdown only
// offers what Polaris already knows (asset manufacturers + the alias/OUI
// canonicals from MAC & Vendor Identification) so a profile is far likelier to
// be spelled the way `getProfileFor` resolves it. Same open-on-click combobox
// the automations wizard uses; `<datalist>` is deliberately avoided (most
// browsers won't open one on click).

var _MFG_SUGGEST_SOURCE_LABELS = { asset: "in inventory", alias: "alias", oui: "OUI override" };

function _mfgSuggestEls() {
  var input = document.getElementById("f-mfg-profile-add-name");
  var box = document.getElementById("mfg-profile-add-suggest");
  return input && box ? { input: input, box: box } : null;
}

function _closeMfgSuggest(box) {
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
}

// Fetch-once, coalesced. A failure closes the dropdown silently — suggestions
// are an aid, and the operator can always type the name.
function _ensureMfgSuggestions() {
  if (_mfgSuggestions) return Promise.resolve(_mfgSuggestions);
  if (!_mfgSuggestionsPromise) {
    _mfgSuggestionsPromise = api.serverSettings.listManufacturerSuggestions()
      .then(function (resp) {
        _mfgSuggestions = (resp && resp.suggestions) || [];
        return _mfgSuggestions;
      })
      .catch(function () { _mfgSuggestions = []; return _mfgSuggestions; })
      .finally(function () { _mfgSuggestionsPromise = null; });
  }
  return _mfgSuggestionsPromise;
}

function _renderMfgSuggest(input, box, rows) {
  var q = (input.value || "").trim().toLowerCase();
  // Prefix matches first, then interior — typing "ar" should offer "Aruba"
  // before "Hikari". An exact match is kept, and leads: dropping it made a
  // correct name ("APC", carried by 8 devices) read as "No known manufacturer
  // matches".
  var matches = _filterSuggestRows(rows, q);
  matches = matches.slice(0, 50);
  if (!matches.length) {
    // Suggestions leave out manufacturers that already have a profile, so a
    // name with no match may be one of those — say so rather than invite an
    // Add that 409s.
    var taken = q && (_mfgProfiles || []).some(function (p) { return (p.manufacturer || "").toLowerCase() === q; });
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (taken ? "A profile for this manufacturer already exists — open it above."
         : q ? "No known manufacturer matches — press Add to create it anyway."
         : "No suggestions yet — every known manufacturer already has a profile.") +
      '</div>';
    box.classList.add("open");
    return;
  }
  box.innerHTML = matches.map(function (r) {
    var hints = (r.sources || []).map(function (s) {
      return s === "asset" && r.assetCount
        ? _mfgDeviceCountLabel(r.assetCount)
        : (_MFG_SUGGEST_SOURCE_LABELS[s] || s);
    });
    return _mfgSuggestItemHTML(r.value, hints);
  }).join("");
  box.classList.add("open");
}

/** Both manufacturer pickers' filter: rows containing `q` (lowercased), the
 *  exact match first, then prefix matches, then interior ones. The sort is
 *  stable, so the caller's order (device count) holds within each band. */
function _filterSuggestRows(rows, q) {
  var matches = rows.filter(function (r) { return !q || r.value.toLowerCase().indexOf(q) !== -1; });
  if (!q) return matches;
  function rank(r) {
    var v = r.value.toLowerCase();
    return v === q ? 0 : v.indexOf(q) === 0 ? 1 : 2;
  }
  return matches.sort(function (a, b) { return rank(a) - rank(b); });
}

// Shared by both manufacturer pickers so "· 8 devices" reads the same on each.
function _mfgDeviceCountLabel(n) {
  return n + " device" + (n === 1 ? "" : "s");
}

function _mfgSuggestItemHTML(value, hints) {
  return '<div class="aw-suggest-item" data-val="' + escapeHtml(value) + '">' +
    escapeHtml(value) +
    (hints.length ? ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(hints.join(" · ")) + '</span>' : "") +
  '</div>';
}

function _openMfgSuggest() {
  var els = _mfgSuggestEls();
  if (!els) return;
  _ensureMfgSuggestions().then(function (rows) {
    // The card re-renders freely; bail if this input is no longer the live one.
    var live = _mfgSuggestEls();
    if (!live || live.input !== els.input || document.activeElement !== live.input) return;
    _renderMfgSuggest(live.input, live.box, rows);
  });
}

function wireManufacturerSuggestCombo() {
  var els = _mfgSuggestEls();
  if (!els) return;
  var input = els.input, box = els.box;

  input.addEventListener("focus", _openMfgSuggest);
  input.addEventListener("click", _openMfgSuggest);
  input.addEventListener("input", function () {
    if (_mfgSuggestions) _renderMfgSuggest(input, box, _mfgSuggestions);
    else _openMfgSuggest();
  });
  input.addEventListener("blur", function () {
    // Delay so a mousedown on an item (which fires before blur completes) lands.
    setTimeout(function () { _closeMfgSuggest(box); }, 150);
  });
  box.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    input.value = item.getAttribute("data-val");
    _closeMfgSuggest(box);
  });
  input.addEventListener("keydown", function (e) {
    var open = box.classList.contains("open");
    if (e.key === "Escape") { if (open) { _closeMfgSuggest(box); e.stopPropagation(); } return; }
    if (e.key === "Enter" && !open) { addManufacturerProfile(); return; }
    if (!open) return;
    var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A highlighted suggestion completes the box; otherwise Enter submits
      // whatever was typed, so a custom name never needs a mouse.
      if (idx >= 0) { input.value = items[idx].getAttribute("data-val"); _closeMfgSuggest(box); }
      else { _closeMfgSuggest(box); addManufacturerProfile(); }
    }
  });
}

// ─── Manufacturer-with-device-count typeahead ──────────────────────────────
// Shared by the MIB upload form and the Device Icons card. A vendor MIB (or
// icon) only applies to assets whose manufacturer matches the name it is saved
// under, so the picker leads with the manufacturers actually in inventory —
// most devices first, each with its count — and follows with names only an
// earlier MIB / alias / icon carries. Free text is still accepted. Counts come
// from `_mibFacets.assetCounts`, already loaded with the tab; no extra fetch.

/** De-duplicated (case-insensitive, first spelling wins) rows with their
 *  device counts, most devices first, then alphabetical. */
function _manufacturerCountRows(names) {
  var counts = (_mibFacets && _mibFacets.assetCounts) || {};
  var byKey = {};
  var rows = [];
  (names || []).forEach(function (n) {
    var v = (n || "").trim();
    var k = v.toLowerCase();
    if (!v || byKey[k]) return;
    byKey[k] = { value: v, assetCount: 0 };
    rows.push(byKey[k]);
  });
  // A count keyed by a different casing still lands on its row.
  Object.keys(counts).forEach(function (m) {
    var row = byKey[m.trim().toLowerCase()];
    if (row) row.assetCount += counts[m];
  });
  return rows.sort(function (a, b) { return b.assetCount - a.assetCount || a.value.localeCompare(b.value); });
}

function _mibUploadMfrRows() {
  return _manufacturerCountRows((_mibFacets && _mibFacets.manufacturers) || []);
}

function _renderManufacturerCountSuggest(input, box, rows) {
  var q = (input.value || "").trim().toLowerCase();
  var matches = _filterSuggestRows(rows, q).slice(0, 50);
  if (!matches.length) {
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (q ? "No known manufacturer matches — the name is used as typed."
         : "No manufacturers in inventory yet — type the vendor name.") +
      '</div>';
    box.classList.add("open");
    return;
  }
  box.innerHTML = matches.map(function (r) {
    return _mfgSuggestItemHTML(r.value, r.assetCount ? [_mfgDeviceCountLabel(r.assetCount)] : []);
  }).join("");
  box.classList.add("open");
}

function wireMibUploadManufacturerCombo() {
  _wireManufacturerCountCombo("f-mib-up-mfr", "mib-up-mfr-suggest", _mibUploadMfrRows);
}

function _wireManufacturerCountCombo(inputId, boxId, rowsFn) {
  var input = document.getElementById(inputId);
  var box = document.getElementById(boxId);
  if (!input || !box) return;
  function open() { _renderManufacturerCountSuggest(input, box, rowsFn()); }

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", open);
  input.addEventListener("blur", function () {
    // Delay so a mousedown on an item (which fires before blur completes) lands.
    setTimeout(function () { _closeMfgSuggest(box); }, 150);
  });
  box.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    input.value = item.getAttribute("data-val");
    _closeMfgSuggest(box);
  });
  input.addEventListener("keydown", function (e) {
    if (!box.classList.contains("open")) return;
    if (e.key === "Escape") { _closeMfgSuggest(box); e.stopPropagation(); return; }
    var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      input.value = items[idx].getAttribute("data-val");
      _closeMfgSuggest(box);
    }
  });
}

// ─── Export / import a profile ─────────────────────────────────────────────
// The file names MIBs and credentials by NAME (no ids, no secrets) and carries
// no per-asset widget switches. Import previews every item — create or
// replace, and any MIB this install lacks — and brings in only what is ticked.
// A widget whose MIB is missing cannot be imported and is offered disabled
// until the MIB is uploaded.

/** The portable form of a View Code body: the same JSON minus every row id. */
function _profileForExport(code) {
  var file = JSON.parse(JSON.stringify(code));
  (file.widgets || []).forEach(function (w) { delete w.id; });
  (file.metrics || []).forEach(function (m) { (m.overrides || []).forEach(function (o) { delete o.id; }); });
  file.exportedAt = new Date().toISOString();
  return file;
}

function _downloadProfileFile(file) {
  var name = String(file.manufacturer || "profile").replace(/[^A-Za-z0-9._-]+/g, "_") + ".manufacturer-profile.json";
  var blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  var mibs = (file.mibs || []).map(function (m) { return m.moduleName; });
  showToast("Exported " + file.manufacturer + (mibs.length ? " — it needs " + mibs.join(", ") + " uploaded where it is imported" : ""), "success");
}

/**
 * What a View Code save would REMOVE — deleted widgets (their per-device
 * switches go with them), deleted per-type / per-model rows, and metric rows
 * cleared back to the built-in seed — for the confirm before saving.
 */
function _profileCodeRemovals(original, edited) {
  var out = [];
  var keptWidgets = {};
  (edited.widgets || []).forEach(function (w) { if (w.id) keptWidgets[w.id] = 1; });
  (original.widgets || []).forEach(function (w) { if (!keptWidgets[w.id]) out.push("delete widget \"" + w.name + "\" (and its per-device switches)"); });
  (original.metrics || []).forEach(function (m) {
    var e = (edited.metrics || []).find(function (x) { return x.metricKey === m.metricKey; });
    if (!e && (m.symbol || m.symbolB)) out.push("clear the " + m.metricKey + " row back to the built-in default");
    var kept = {};
    ((e && e.overrides) || []).forEach(function (o) { if (o.id) kept[o.id] = 1; });
    (m.overrides || []).forEach(function (o) {
      if (!kept[o.id]) out.push("delete the " + m.metricKey + " row for " + (o.assetType || "") + (o.assetType && o.modelPattern ? " / " : "") + (o.modelPattern || ""));
    });
  });
  return out;
}

// View Code — the automations idiom (PolarisAutomationPortability.openCodeModal):
// the profile as editable JSON, with Copy, Export (the portable file, ids
// stripped) and Save changes (a FULL replace — rows left out are cleared or
// deleted, confirmed first).
async function openProfileCodeModal(id) {
  var code;
  try {
    code = await api.serverSettings.getManufacturerProfileCode(id);
  } catch (err) {
    showToast(err.message || "Could not load the profile", "error");
    return;
  }
  var canSave = permAtLeast("serverSettingsSystem", "write"); // Charon key (polaris: manufacturerProfiles)
  var text = JSON.stringify(code, null, 2);
  var note =
    '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
      'This is the <b>' + escapeHtml(code.manufacturer) + '</b> profile as it is stored. ' +
      (canSave
        ? '<strong>Saving replaces the whole profile</strong>: a metric row you remove goes back to the built-in default, and a per-type / per-model row or widget you remove is deleted. ' +
          'Rows keep their <code>id</code> so an edit updates them in place; a row without one is added. MIBs and credentials are named — the names must exist on this install.'
        : 'You do not have permission to change it.') +
    '</p>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">' +
      '<strong>Copy</strong> gives you exactly what is shown; <strong>Export</strong> downloads the portable file instead (the same, minus row ids), which another install can import.' +
    '</p>';
  var body = note +
    '<textarea id="pcode-text" rows="24" spellcheck="false" ' + (canSave ? "" : "readonly ") +
      'style="width:100%;font-family:var(--font-mono);font-size:0.8rem;line-height:1.45">' + escapeHtml(text) + '</textarea>' +
    '<div id="pcode-err" class="form-error" style="display:none;margin-top:0.5rem;white-space:pre-wrap"></div>';
  var footer =
    '<button class="btn btn-secondary" id="pcode-export" type="button" title="Download this profile as a portable file">Export</button>' +
    '<button class="btn btn-secondary" id="pcode-copy" type="button">Copy</button>' +
    '<button class="btn btn-secondary" id="pcode-cancel" type="button">' + (canSave ? "Cancel" : "Close") + '</button>' +
    (canSave ? '<button class="btn btn-primary" id="pcode-save" type="button">Save changes</button>' : "");
  var ov = buildOverlay(1300, code.manufacturer + " — profile code", body, footer, null, true);
  var ta = ov.overlay.querySelector("#pcode-text");
  var errBox = ov.overlay.querySelector("#pcode-err");
  function showErr(msg) { errBox.textContent = msg; errBox.style.display = ""; }

  /** The textarea as a profile object, or null with the error shown. Export and
   *  Save share it, so an unparseable edit is never exported off the last good
   *  version without saying so. */
  function readEdited() {
    errBox.style.display = "none";
    var parsed;
    try { parsed = JSON.parse(ta.value); } catch (err) {
      showErr("Invalid JSON: " + ((err && err.message) || "could not be parsed"));
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { showErr("The profile must be a JSON object."); return null; }
    return parsed;
  }

  ov.overlay.querySelector("#pcode-cancel").addEventListener("click", function () { ov.close(); });
  ov.overlay.querySelector("#pcode-export").addEventListener("click", function () {
    var parsed = readEdited();
    if (parsed) _downloadProfileFile(_profileForExport(parsed));
  });
  ov.overlay.querySelector("#pcode-copy").addEventListener("click", function () {
    var btn = this;
    function done(ok) { btn.textContent = ok ? "Copied" : "Copy failed"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(function () { done(true); }, function () { done(false); });
    } else {
      try { ta.select(); document.execCommand("copy"); done(true); } catch (_e) { done(false); }
    }
  });
  if (canSave) {
    ov.overlay.querySelector("#pcode-save").addEventListener("click", async function () {
      var btn = this;
      var parsed = readEdited();
      if (!parsed) return;
      if (JSON.stringify(parsed) === JSON.stringify(code)) { ov.close(); return; }
      var removals = _profileCodeRemovals(code, parsed);
      if (removals.length) {
        var ok = await showConfirm("Save these changes? Saving will also:\n\n" + removals.map(function (r) { return "- " + r; }).join("\n"));
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        await api.serverSettings.saveManufacturerProfileCode(id, parsed);
        ov.close();
        showToast("Profile saved", "success");
        var listResp = await api.serverSettings.listManufacturerProfiles();
        _mfgProfiles = (listResp && listResp.profiles) || _mfgProfiles;
        var detail = await api.serverSettings.getManufacturerProfile(id);
        _mfgProfileDetail[id] = detail && detail.profile;
        renderIdentificationTab();
      } catch (err) {
        btn.disabled = false;
        showErr((err && err.message) || "Save failed");
      }
    });
  }
}

var PROFILE_IMPORT_MAX_BYTES = 1024 * 1024;
var PROFILE_IMPORT_GROUPS = [
  ["settings", "Profile"], ["metric", "Metric rows"], ["override", "Per-type / per-model rows"],
  ["widget", "Custom widgets"], ["layout", "Custom MIB tab"],
];

async function openProfileImportModal(fileObj) {
  if (fileObj.size > PROFILE_IMPORT_MAX_BYTES) { showToast("That file is too large to be a manufacturer profile", "error"); return; }
  var file;
  try {
    file = JSON.parse(await fileObj.text());
  } catch (_) {
    showToast("That file is not JSON", "error");
    return;
  }
  var preview;
  try {
    preview = await api.serverSettings.previewManufacturerProfileImport(file);
  } catch (err) {
    showToast(err.message || "Could not read that profile", "error");
    return;
  }
  var items = preview.items || [];
  var missing = (preview.mibs || []).filter(function (m) { return !m.present; });
  var mibName = function (m) { return m.moduleName + (m.manufacturer ? " (" + m.manufacturer + (m.model ? " " + m.model : "") + ")" : ""); };

  var body =
    '<p style="margin:0 0 0.6rem;font-size:0.85rem">' +
      (preview.targetProfileId
        ? 'Imports into the existing <b>' + escapeHtml(preview.manufacturer) + '</b> profile. Items marked <b>replaces</b> overwrite what is there.'
        : 'Creates a new <b>' + escapeHtml(preview.manufacturer) + '</b> profile.') +
    '</p>' +
    (missing.length
      ? '<div style="margin:0 0 0.6rem;padding:8px 10px;border:1px solid var(--color-warning,#d97706);border-radius:4px;font-size:0.82rem">' +
          '<b style="color:var(--color-warning,#d97706)">Missing MIB' + (missing.length === 1 ? '' : 's') + ':</b> ' +
          missing.map(function (m) { return '<code>' + escapeHtml(mibName(m)) + '</code>'; }).join(", ") +
          '. Upload ' + (missing.length === 1 ? 'it' : 'them') + ' at MIB Database, then import again. ' +
          'Widgets that need a missing MIB can\'t be imported until then; metric rows import but won\'t resolve.' +
        '</div>'
      : '') +
    '<div style="display:flex;gap:10px;margin-bottom:0.4rem;font-size:0.8rem">' +
      '<a href="#" id="pimp-all">Select all</a><a href="#" id="pimp-none">Select none</a>' +
    '</div>' +
    '<div style="max-height:50vh;overflow:auto;border:1px solid var(--color-border);border-radius:4px;padding:6px 10px">' +
    PROFILE_IMPORT_GROUPS.map(function (g) {
      var group = items.filter(function (it) { return it.kind === g[0]; });
      if (!group.length) return "";
      return '<div style="font-size:0.74rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);margin:8px 0 4px">' + escapeHtml(g[1]) + '</div>' +
        group.map(function (it) {
          var notes = [];
          if (it.action === "replace") notes.push('<span style="color:var(--color-warning,#d97706)">replaces existing</span>');
          if (it.missingMibs && it.missingMibs.length) notes.push('<span style="color:var(--color-warning,#d97706)">MIB missing: ' + escapeHtml(it.missingMibs.map(function (m) { return m.moduleName; }).join(", ")) + '</span>');
          if (it.missingCredential) notes.push('<span style="color:var(--color-warning,#d97706)">no credential named "' + escapeHtml(it.missingCredential) + '" — imports unauthenticated</span>');
          if (it.blocked) notes.push('<span style="color:var(--color-danger)">' + escapeHtml(it.blocked) + '</span>');
          return '<label style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;font-size:0.84rem' + (it.blocked ? ';opacity:0.6' : '') + '">' +
            '<input type="checkbox" class="pimp-item" value="' + escapeHtml(it.id) + '"' + (it.blocked ? ' disabled' : ' checked') + ' style="margin-top:3px">' +
            '<span>' + escapeHtml(it.label) + (notes.length ? '<br><span style="font-size:0.76rem">' + notes.join(" · ") + '</span>' : '') + '</span>' +
          '</label>';
        }).join("");
    }).join("") +
    '</div>';
  openModal("Import manufacturer profile", body,
    '<button class="btn btn-secondary" id="pimp-cancel">Cancel</button><button class="btn btn-primary" id="pimp-go">Import</button>');

  var boxes = Array.prototype.slice.call(document.querySelectorAll("#modal-overlay .pimp-item"));
  var go = document.getElementById("pimp-go");
  function refresh() {
    var n = boxes.filter(function (b) { return b.checked; }).length;
    go.textContent = n ? "Import " + n + " item" + (n === 1 ? "" : "s") : "Import";
    go.disabled = n === 0;
  }
  boxes.forEach(function (b) { b.addEventListener("change", refresh); });
  document.getElementById("pimp-all").addEventListener("click", function (e) { e.preventDefault(); boxes.forEach(function (b) { if (!b.disabled) b.checked = true; }); refresh(); });
  document.getElementById("pimp-none").addEventListener("click", function (e) { e.preventDefault(); boxes.forEach(function (b) { b.checked = false; }); refresh(); });
  document.getElementById("pimp-cancel").addEventListener("click", closeModal);
  go.addEventListener("click", async function () {
    var picked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    go.disabled = true;
    try {
      var res = await api.serverSettings.applyManufacturerProfileImport(file, picked);
      var failed = (res.results || []).filter(function (r) { return !r.ok; });
      closeModal();
      if (failed.length) {
        showToast((res.results.length - failed.length) + " imported, " + failed.length + " failed: " +
          failed.map(function (r) { return r.id + " — " + r.error; }).join("; "), "error");
      } else {
        showToast("Imported " + res.results.length + " item" + (res.results.length === 1 ? "" : "s") + " into " + preview.manufacturer, "success");
      }
      // Fresh list (counts, a new profile) and no stale detail for the target.
      var listResp = await api.serverSettings.listManufacturerProfiles();
      _mfgProfiles = (listResp && listResp.profiles) || _mfgProfiles;
      var detail = await api.serverSettings.getManufacturerProfile(res.profileId);
      _mfgProfileDetail[res.profileId] = detail && detail.profile;
      _mfgProfileExpanded[res.profileId] = true;
      _mfgSuggestions = null;
      renderIdentificationTab();
    } catch (err) {
      go.disabled = false;
      showToast(err.message || "Import failed", "error");
    }
  });
  refresh();
}

async function addManufacturerProfile() {
  var input = document.getElementById("f-mfg-profile-add-name");
  var name = input && input.value ? input.value.trim() : "";
  if (!name) { showToast("Manufacturer is required", "error"); return; }
  try {
    var resp = await api.serverSettings.createManufacturerProfile({ manufacturer: name });
    if (resp && resp.profile) {
      _mfgProfiles.unshift({
        id:             resp.profile.id,
        manufacturer:   resp.profile.manufacturer,
        metricCount:    resp.profile.metrics.length,
        overrideCount:  0,
        widgetCount:    0,
        scopedMibCount: 0,
        createdAt:      resp.profile.createdAt,
        updatedAt:      resp.profile.updatedAt,
      });
      _mfgProfileDetail[resp.profile.id] = resp.profile;
      _mfgProfileExpanded[resp.profile.id] = true;
    }
    input.value = "";
    // The name just used now has a profile, so it must drop out of the list.
    _mfgSuggestions = null;
    showToast("Manufacturer profile added");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Create failed", "error");
  }
}

async function deleteManufacturerProfile(id) {
  var profile = _mfgProfiles.find(function (p) { return p.id === id; });
  if (!profile) return;
  var ok = await showConfirm('Delete the "' + profile.manufacturer + '" profile?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerProfile(id);
    _mfgProfiles = _mfgProfiles.filter(function (p) { return p.id !== id; });
    delete _mfgProfileDetail[id];
    delete _mfgProfileExpanded[id];
    // Freed up — the manufacturer is suggestable again.
    _mfgSuggestions = null;
    showToast("Profile deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

async function toggleProfileExpand(id) {
  if (!id) return;
  if (_mfgProfileExpanded[id]) {
    _mfgProfileExpanded[id] = false;
    renderIdentificationTab();
    return;
  }
  _mfgProfileExpanded[id] = true;
  if (!_mfgProfileDetail[id]) {
    renderIdentificationTab();
    try {
      var resp = await api.serverSettings.getManufacturerProfile(id);
      _mfgProfileDetail[id] = resp.profile;
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message || "Load failed", "error");
    }
  } else {
    renderIdentificationTab();
  }
}

function beginMetricEdit(tr) {
  if (!tr) return;
  _mfgProfileMetricEdit[tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key")] = true;
  renderIdentificationTab();
}

function cancelMetricEdit(tr) {
  if (!tr) return;
  var pid = tr.getAttribute("data-profile-id");
  var mk  = tr.getAttribute("data-metric-key");
  delete _mfgProfileMetricEdit[pid + ":" + mk];
  delete _mfgEditMibSelections["metric:" + pid + ":" + mk];
  delete _mfgEditTypeSelections["metric:" + pid + ":" + mk];
  renderIdentificationTab();
}

async function saveMetricEdit(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var transform = (tr.querySelector(".mfg-edit-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-edit-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-edit-type")      || {}).value || "scalar";
  // Single dropdown value carries either a UUID, a std:* key, or "" — split
  // into the per-column shape the backend persists.
  var mibSplit = splitMibSelection(mibSel);
  var pair     = _readSymbolPair(tr, "mfg-edit-sym", type);
  if (type === "double_scalar" && (!pair.symbol || !pair.symbolB)) {
    showToast("Both Symbol A and Symbol B are required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-edit", metricKey);
  var payload = {
    defaultSymbol:    pair.symbol || null,
    defaultSymbolB:   type === "double_scalar" ? (pair.symbolB || null) : null,
    defaultMibId:     mibSplit.mibId,
    defaultMibStdKey: mibSplit.mibStdKey,
    defaultType:      type,
    defaultTransform: transform || null,
    defaultAggregate:     extras.aggregate,
    defaultLabel:         extras.label,
    defaultParsePattern:  extras.parsePattern,
    defaultParseTemplate: extras.parseTemplate,
    defaultSensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetric(profileId, metricKey, payload);
    if (resp && resp.metric) updateMetricInDetail(profileId, resp.metric);
    delete _mfgProfileMetricEdit[profileId + ":" + metricKey];
    delete _mfgEditMibSelections["metric:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["metric:" + profileId + ":" + metricKey];
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

// Opens (or closes) a metric's add-override form. Closing drops the form's
// pending MIB / type picks so a reopen starts blank.
function toggleOverrideAdd(tr, open) {
  if (!tr) return;
  var key = tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key");
  if (open) {
    _mfgOverrideAddOpen[key] = true;
  } else {
    delete _mfgOverrideAddOpen[key];
    delete _mfgEditMibSelections["new:" + key];
    delete _mfgEditTypeSelections["new:" + key];
  }
  renderIdentificationTab();
}

async function addOverride(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var pattern   = (tr.querySelector(".mfg-new-override-pattern")   || {}).value || "";
  var devType   = (tr.querySelector(".mfg-new-override-assettype") || {}).value || "";
  var transform = (tr.querySelector(".mfg-new-override-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-new-override-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-new-override-type")      || {}).value || "scalar";
  var mibSplit  = splitMibSelection(mibSel);
  // Scope rule, mirrored from the server: a row needs a device type, a model
  // pattern, or both. Neither would match anything.
  if (!pattern.trim() && !devType) {
    showToast("Pick a device type, a model regex, or both", "error");
    return;
  }
  var pair = _readSymbolPair(tr, "mfg-new-override-sym", type);
  if (!pair.symbol) { showToast("Symbol A is required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-new-override", metricKey);
  var payload = {
    assetType:    devType || null,
    modelPattern: pattern.trim() || null,
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
    aggregate:     extras.aggregate,
    label:         extras.label,
    parsePattern:  extras.parsePattern,
    parseTemplate: extras.parseTemplate,
    sensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.createProfileMetricOverride(profileId, metricKey, payload);
    if (resp && resp.override) appendOverrideToDetail(profileId, metricKey, resp.override);
    delete _mfgEditMibSelections["new:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["new:" + profileId + ":" + metricKey];
    delete _mfgOverrideAddOpen[profileId + ":" + metricKey];
    showToast("Override added");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Add override failed", "error");
  }
}

function beginOverrideEdit(tr) {
  if (!tr) return;
  _mfgProfileOverrideEdit[tr.getAttribute("data-override-id")] = true;
  renderIdentificationTab();
}

function cancelOverrideEdit(tr) {
  if (!tr) return;
  var oid = tr.getAttribute("data-override-id");
  delete _mfgProfileOverrideEdit[oid];
  delete _mfgEditMibSelections["override:" + oid];
  delete _mfgEditTypeSelections["override:" + oid];
  renderIdentificationTab();
}

async function saveOverrideEdit(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var pattern    = (tr.querySelector(".mfg-edit-override-pattern")   || {}).value || "";
  var devType    = (tr.querySelector(".mfg-edit-override-assettype") || {}).value || "";
  var mibSel     = (tr.querySelector(".mfg-edit-override-mib")       || {}).value || "";
  var transform  = (tr.querySelector(".mfg-edit-override-transform") || {}).value || "";
  var type       = (tr.querySelector(".mfg-edit-override-type")      || {}).value || "scalar";
  var mibSplit   = splitMibSelection(mibSel);
  if (!pattern.trim() && !devType) {
    showToast("Pick a device type, a model regex, or both", "error");
    return;
  }
  var pair = _readSymbolPair(tr, "mfg-edit-override-sym", type);
  if (!pair.symbol) { showToast("Symbol A is required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-edit-override", metricKey);
  var payload = {
    assetType:    devType || null,
    modelPattern: pattern.trim() || null,
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
    aggregate:     extras.aggregate,
    label:         extras.label,
    parsePattern:  extras.parsePattern,
    parseTemplate: extras.parseTemplate,
    sensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetricOverride(profileId, metricKey, overrideId, payload);
    if (resp && resp.override) replaceOverrideInDetail(profileId, metricKey, resp.override);
    delete _mfgProfileOverrideEdit[overrideId];
    delete _mfgEditMibSelections["override:" + overrideId];
    delete _mfgEditTypeSelections["override:" + overrideId];
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

function replaceOverrideInDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m || !m.overrides) return;
  for (var i = 0; i < m.overrides.length; i++) {
    if (m.overrides[i].id === override.id) { m.overrides[i] = override; return; }
  }
}

async function deleteOverride(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var ok = await showConfirm("Delete this override?", "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileMetricOverride(profileId, metricKey, overrideId);
    removeOverrideFromDetail(profileId, metricKey, overrideId);
    showToast("Override deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function updateMetricInDetail(profileId, metric) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  for (var i = 0; i < d.metrics.length; i++) {
    if (d.metrics[i].metricKey === metric.metricKey) {
      d.metrics[i] = metric;
      return;
    }
  }
}

function appendOverrideToDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).concat([override]);
  // Bump summary count so the row's "N overrides" line stays in sync until
  // the next full reload.
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.overrideCount += 1;
}

function removeOverrideFromDetail(profileId, metricKey, overrideId) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).filter(function (o) { return o.id !== overrideId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.overrideCount > 0) summary.overrideCount -= 1;
}

// ─── Widget mutations ─────────────────────────────────────────────────

// Read the shared widget form (Add or Edit card) into a payload the
// backend route accepts. Returns null + toasts on validation failure.
function _readWidgetFormPayload(scope) {
  if (!scope) return null;
  var name           = (scope.querySelector(".mfg-widget-name")        || {}).value || "";
  var mibSel         = (scope.querySelector(".mfg-widget-mib")         || {}).value || "";
  var typeSel        = (scope.querySelector(".mfg-widget-type")        || {}).value || "scalar";
  var widgetType     = (scope.querySelector(".mfg-widget-widgettype")  || {}).value || "gauge";
  var symbol         = (scope.querySelector(".mfg-widget-symbol")      || {}).value || "";
  var modelPattern   = (scope.querySelector(".mfg-widget-model")       || {}).value || "";
  var orderRaw       = (scope.querySelector(".mfg-widget-order")       || {}).value || "0";
  var transform      = (scope.querySelector(".mfg-widget-transform")   || {}).value || "";

  if (!name.trim())   { showToast("Widget name is required", "error");                 return null; }

  // An http widget names a request, not an OID, so the MIB/symbol pair is
  // required for every OTHER type. Mirrors the same split in
  // manufacturerProfileService.createWidget.
  var isHttp = widgetType === "http";
  var mibSplit = splitMibSelection(mibSel);
  if (!isHttp) {
    // Backend requires a real MibFile UUID — std:* keys aren't acceptable
    // because the asset-side collector needs an enumerable symbol directory
    // to walk against on the device.
    if (!mibSplit.mibId) { showToast("Pick an uploaded MIB (Standard MIBs aren't supported for widgets)", "error"); return null; }
    if (!symbol.trim()) { showToast("Symbol is required", "error");                     return null; }
  }

  var displayOptions = _readWidgetDisplayOptions(scope, widgetType);
  var payload = {
    name:           name.trim(),
    symbol:         isHttp ? null : symbol.trim(),
    mibId:          isHttp ? null : mibSplit.mibId,
    type:           typeSel,
    widgetType:     widgetType,
    transform:      transform || null,
    displayOptions: displayOptions,
    order:          Number(orderRaw) || 0,
    modelPattern:   modelPattern.trim() ? modelPattern.trim() : null,
  };
  if (isHttp) {
    payload.httpCheck    = _readWidgetHttpCheck(scope);
    payload.credentialId = (scope.querySelector(".mfg-http-cred") || {}).value || null;
  }
  if (widgetType === "state") {
    var mode      = (scope.querySelector(".mfg-widget-statemode")    || {}).value || "nonzero";
    var valuesRaw = (scope.querySelector(".mfg-widget-statevalues")  || {}).value || "";
    var trueLabel = (scope.querySelector(".mfg-widget-statetrue")    || {}).value || "";
    var falseLabel= (scope.querySelector(".mfg-widget-statefalse")   || {}).value || "";
    var labelSym  = (scope.querySelector(".mfg-widget-labelsymbol")  || {}).value || "";
    var problemEl = scope.querySelector(".mfg-widget-stateproblem");
    var values = valuesRaw.split(",").map(function (v) { return v.trim(); }).filter(function (v) { return v !== ""; });
    // Caught here as well as server-side: a probe whose comparison set is empty
    // would evaluate every reading to false and look healthy forever.
    if (STATE_MODES_WITH_VALUES.indexOf(mode) !== -1 && values.length === 0) {
      showToast("That state mode needs at least one comparison value", "error");
      return null;
    }
    payload.stateMap = {
      mode: mode,
      values: values,
      trueLabel: trueLabel.trim() || "Alarm",
      falseLabel: falseLabel.trim() || "OK",
      trueIsProblem: problemEl ? !!problemEl.checked : true,
    };
    payload.labelSymbol = typeSel === "table" && labelSym.trim() ? labelSym.trim() : null;
  }
  return payload;
}

async function saveNewWidget(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var payload = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.createProfileWidget(profileId, payload);
    if (resp && resp.widget) appendWidgetToDetail(profileId, resp.widget);
    delete _mfgAddingWidget[profileId];
    _mfgWidgetClearShadow("new-widget:" + profileId);
    showToast("Widget added");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
    // Business rule 130: a new widget polls nothing until it is switched on
    // for an asset, so offer the devices it applies to straight away.
    if (resp && resp.widget && permAtLeast("assets", "write")) {
      openWidgetDevicesModal(profileId, resp.widget, true);
    }
  } catch (err) {
    showToast(err.message || "Add widget failed", "error");
  }
}

// ─── "Enable on these devices" (business rule 130) ─────────────────────────
// Lists the assets a widget applies to (its profile's manufacturer + optional
// model pattern) with a checkbox each. Opened right after a widget is created
// (nothing is checked — a new widget polls nothing until chosen here or on an
// asset's Custom MIB tab) and from the widget card's Devices… button (current
// state pre-checked). Saves only the difference.
async function openWidgetDevicesModal(profileId, widget, isNew) {
  var title = (isNew ? "Enable " : "Devices for ") + '"' + widget.name + '"';
  openModal(title, '<p class="empty-state" style="margin:0">Loading devices…</p>',
    '<button class="btn btn-secondary" id="wdev-cancel">' + (isNew ? "Skip for now" : "Cancel") + '</button>');
  document.getElementById("wdev-cancel").addEventListener("click", closeModal);
  var rows;
  try {
    rows = ((await api.serverSettings.listProfileWidgetAssets(profileId, widget.id)) || {}).assets || [];
  } catch (err) {
    var b = document.querySelector("#modal-overlay .modal-body");
    if (b) b.innerHTML = '<p style="color:var(--color-danger);margin:0">' + escapeHtml(err.message || "Could not load devices") + '</p>';
    return;
  }
  var initial = {};
  rows.forEach(function (r) { initial[r.id] = !!r.enabled; });
  var body = document.querySelector("#modal-overlay .modal-body");
  var footer = document.querySelector("#modal-overlay .modal-footer");
  if (!body || !footer) return;

  if (!rows.length) {
    body.innerHTML = '<p style="margin:0">No assets match this widget yet' +
      (widget.modelPattern ? ' (manufacturer + model pattern <code>' + escapeHtml(widget.modelPattern) + '</code>)' : '') +
      '. It can be switched on later from an asset\'s Custom MIB tab or this card\'s Devices… button.</p>';
    return;
  }

  body.innerHTML =
    '<p style="margin:0 0 0.6rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
      (isNew
        ? 'This widget polls nothing until it is switched on for a device. Choose the devices to start polling it on now.'
        : 'Checked devices poll this widget on their hardware-sensor interval. Unchecking one stops polling it; its collected history stays.') +
    '</p>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:0.5rem">' +
      '<input type="search" id="wdev-filter" placeholder="Filter by name, IP or model" style="flex:1">' +
      '<span id="wdev-count" style="font-size:0.8rem;color:var(--color-text-tertiary);white-space:nowrap"></span>' +
    '</div>' +
    '<div style="max-height:50vh;overflow:auto;border:1px solid var(--color-border);border-radius:4px">' +
      '<table class="data-table" style="font-size:0.84rem;margin:0"><thead><tr>' +
        '<th style="width:32px"><input type="checkbox" id="wdev-all" title="Select every listed device"></th>' +
        '<th>Device</th><th>IP address</th><th>Model</th><th>Status</th>' +
      '</tr></thead><tbody id="wdev-rows">' +
      rows.map(function (r) {
        var hay = [r.hostname, r.ipAddress, r.model].filter(Boolean).join(" ").toLowerCase();
        return '<tr data-hay="' + escapeHtml(hay) + '">' +
          '<td><input type="checkbox" class="wdev-pick" data-id="' + escapeHtml(r.id) + '"' + (r.enabled ? " checked" : "") + '></td>' +
          '<td>' + escapeHtml(r.hostname || "—") + (r.monitored ? '' : ' <span style="font-size:0.75rem;color:var(--color-text-tertiary)">(not monitored)</span>') + '</td>' +
          '<td class="mono">' + escapeHtml(r.ipAddress || "—") + '</td>' +
          '<td>' + escapeHtml(r.model || "—") + '</td>' +
          '<td>' + escapeHtml(r.monitorStatus || "—") + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table>' +
    '</div>';
  footer.innerHTML =
    '<button class="btn btn-secondary" id="wdev-cancel">' + (isNew ? "Skip for now" : "Cancel") + '</button>' +
    '<button class="btn btn-primary" id="wdev-save"></button>';

  var picks = Array.prototype.slice.call(body.querySelectorAll(".wdev-pick"));
  var allBox = document.getElementById("wdev-all");
  var saveBtn = document.getElementById("wdev-save");
  function visible(p) { return p.closest("tr").style.display !== "none"; }
  function refresh() {
    var checked = picks.filter(function (p) { return p.checked; }).length;
    var changed = picks.filter(function (p) { return p.checked !== initial[p.getAttribute("data-id")]; }).length;
    document.getElementById("wdev-count").textContent = checked + " of " + picks.length + " selected";
    saveBtn.textContent = isNew ? (checked ? "Enable on " + checked + " device" + (checked === 1 ? "" : "s") : "Enable") : "Save";
    saveBtn.disabled = changed === 0;
    var vis = picks.filter(visible);
    allBox.checked = vis.length > 0 && vis.every(function (p) { return p.checked; });
  }
  picks.forEach(function (p) { p.addEventListener("change", refresh); });
  allBox.addEventListener("change", function () {
    picks.filter(visible).forEach(function (p) { p.checked = allBox.checked; });
    refresh();
  });
  document.getElementById("wdev-filter").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    picks.forEach(function (p) {
      var tr = p.closest("tr");
      tr.style.display = !q || tr.getAttribute("data-hay").indexOf(q) !== -1 ? "" : "none";
    });
    refresh();
  });
  document.getElementById("wdev-cancel").addEventListener("click", closeModal);
  saveBtn.addEventListener("click", async function () {
    var enable = [], disable = [];
    picks.forEach(function (p) {
      var id = p.getAttribute("data-id");
      if (p.checked && !initial[id]) enable.push(id);
      if (!p.checked && initial[id]) disable.push(id);
    });
    saveBtn.disabled = true;
    try {
      var res = await api.serverSettings.setProfileWidgetAssets(profileId, widget.id, { enable: enable, disable: disable });
      closeModal();
      var parts = [];
      if (res && res.enabled)  parts.push("on for " + res.enabled);
      if (res && res.disabled) parts.push("off for " + res.disabled);
      showToast('"' + widget.name + '" polling ' + (parts.join(", ") || "unchanged") + " device(s)", "success");
    } catch (err) {
      showToast(err.message || "Could not update devices", "error");
      saveBtn.disabled = false;
    }
  });
  refresh();
}

async function saveWidgetEdit(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var widgetId  = scope.getAttribute("data-widget-id");
  var payload   = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.updateProfileWidget(profileId, widgetId, payload);
    if (resp && resp.widget) replaceWidgetInDetail(profileId, resp.widget);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

async function deleteWidget(profileId, widgetId) {
  if (!profileId || !widgetId) return;
  var d = _mfgProfileDetail[profileId];
  var w = d && (d.widgets || []).find(function (x) { return x.id === widgetId; });
  var name = w ? w.name : "this widget";
  var ok = await showConfirm('Delete the "' + name + '" widget?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileWidget(profileId, widgetId);
    removeWidgetFromDetail(profileId, widgetId);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Widget deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function appendWidgetToDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  d.widgets = (d.widgets || []).concat([widget]);
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.widgetCount = (summary.widgetCount || 0) + 1;
}

function replaceWidgetInDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  for (var i = 0; i < d.widgets.length; i++) {
    if (d.widgets[i].id === widget.id) { d.widgets[i] = widget; return; }
  }
}

function removeWidgetFromDetail(profileId, widgetId) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  d.widgets = d.widgets.filter(function (w) { return w.id !== widgetId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.widgetCount > 0) summary.widgetCount -= 1;
}
