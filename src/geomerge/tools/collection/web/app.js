let rows = [];
let sourcesDir = "";
let requiredFields = [];
let formatOptions = [];
let geographyLevelOptions = [];
let providerFieldDescriptions = {};

async function loadMeta() {
  const res = await fetch("api/meta");
  const meta = await res.json();
  document.getElementById("footer-file-link").textContent = meta.checklist_path;
  sourcesDir = meta.sources_dir;
  requiredFields = meta.required_fields;
  formatOptions = meta.format_options;
  geographyLevelOptions = meta.geography_level_options;
  providerFieldDescriptions = meta.provider_field_descriptions;
}

async function loadRows() {
  const footer = document.getElementById("progress");
  footer.textContent = "Loading…";
  try {
    const res = await fetch("api/rows");
    rows = await res.json();
  } catch (e) {
    footer.textContent = `Failed to load rows: ${e}`;
    throw e;
  }
  document.getElementById("rows").classList.remove("rows-pending");
  render();
}

// outcome (server.py's load_checklist): found | not_found | "" — the Found /
// Not found decision itself, separate from source_url, so a not-found row
// can keep a link to whatever was there (e.g. a PDF, not usable data).
function isDone(row) {
  return Boolean(row.outcome);
}

function isFound(row) {
  return row.outcome === "found";
}

// Reviewed and confirmed no usable data exists — distinct from a row
// that just hasn't been looked at yet.
function isNotFound(row) {
  return row.outcome === "not_found";
}

function isMetadataComplete(row) {
  return row.metadata_status === "complete";
}

// "Complete" means nothing left to do at all — metadata fields filled in AND
// the raw file actually downloaded, not just one or the other.
function isComplete(row) {
  return isMetadataComplete(row) && row.raw_data_status === "complete";
}

function progressText(filterMode) {
  if (filterMode === "metadata_incomplete" || filterMode === "metadata_complete") {
    const sourcesTotal = rows.filter((r) => r.metadata_status !== "none").length;
    const completeCount = rows.filter(isComplete).length;
    return `${completeCount} / ${sourcesTotal} sources complete`;
  }
  const doneCount = rows.filter(isDone).length;
  const foundCount = rows.filter(isFound).length;
  const flaggedCount = rows.filter((r) => r.flagged).length;
  return `${doneCount} / ${rows.length} checked  ·  <span class="found-count">${foundCount} found</span>  ·  ${flaggedCount} flagged`;
}

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  const body = document.getElementById("rows-body");
  body.innerHTML = "";

  // View (top dropdown): cross-column states. Incomplete is everything not
  // marked not found and not yet complete, including unchecked rows.
  // Column filters, sort and search come after (/table-filter.js).
  let visible = rows;
  if (filterMode === "metadata_incomplete") {
    visible = rows.filter((r) => !isNotFound(r) && !isComplete(r));
  } else if (filterMode === "metadata_complete") {
    visible = rows.filter(isComplete);
  }
  visible = tableFilter.apply(visible);

  document.getElementById("progress").innerHTML = progressText(filterMode);

  for (const row of visible) {
    body.appendChild(renderRow(row));
  }
}

// No row tints (like the other dashboards) — the Found / Not found buttons
// and the status pills carry the state. Not-found rows are just dimmed.
function rowClass(row) {
  return isNotFound(row) ? "not-found-row" : "";
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.providerId = row.provider_id;
  tr.className = rowClass(row);

  const nameTd = document.createElement("td");
  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "name-link";
  nameBtn.title = `${row.name} (${row.provider_id}) — click to edit`;
  nameBtn.textContent = row.name;
  nameBtn.onclick = () => openAddSourceModal(row);
  nameTd.appendChild(nameBtn);
  tr.appendChild(nameTd);

  // Province and geography level — plain text, for scanning down the list.
  for (const value of [row.province, row.geography_level]) {
    const td = document.createElement("td");
    td.className = "meta-cell";
    td.textContent = value || "—";
    tr.appendChild(td);
  }

  // Editable, not just a link — providers.csv's snapshot of a portal URL
  // sometimes turns out to be wrong or stale, so this needs to be fixable
  // right here rather than requiring an edit somewhere else entirely.
  const portalTd = document.createElement("td");
  const portalWrapper = document.createElement("div");
  portalWrapper.className = "url-cell";

  const portalOpenLink = document.createElement("a");
  portalOpenLink.className = "open-link" + (row.portal_url ? "" : " disabled");
  portalOpenLink.href = row.portal_url || "#";
  portalOpenLink.target = "_blank";
  portalOpenLink.rel = "noopener";
  portalOpenLink.textContent = "↗";
  portalOpenLink.title = "Open portal";
  portalWrapper.appendChild(portalOpenLink);

  const portalInput = document.createElement("input");
  portalInput.type = "text";
  portalInput.placeholder = "portal URL";
  portalInput.value = row.portal_url || "";
  portalInput.addEventListener("input", () => {
    portalOpenLink.href = portalInput.value || "#";
    portalOpenLink.classList.toggle("disabled", !portalInput.value);
  });
  portalInput.addEventListener("change", () => savePortalUrl(row.row_index, portalInput.value.trim()));
  portalInput.title = row.portal_url || "";
  portalWrapper.appendChild(portalInput);

  portalTd.appendChild(portalWrapper);
  tr.appendChild(portalTd);

  const actionsTd = document.createElement("td");
  actionsTd.className = "actions-cell";
  const foundBtn = document.createElement("button");
  foundBtn.className = "found" + (isFound(row) ? " confirmed" : "");
  foundBtn.textContent = "Found";
  foundBtn.onclick = () => submitFound(row, foundBtn);
  actionsTd.appendChild(foundBtn);

  const notFoundBtn = document.createElement("button");
  notFoundBtn.className = "not-found" + (isNotFound(row) ? " confirmed" : "");
  notFoundBtn.textContent = "Not found";
  notFoundBtn.onclick = () => submitNotFound(row, notFoundBtn);
  actionsTd.appendChild(notFoundBtn);

  const errorDiv = document.createElement("div");
  errorDiv.className = "error";
  errorDiv.id = `error-${row.row_index}`;
  actionsTd.appendChild(errorDiv);
  tr.appendChild(actionsTd);

  const urlTd = document.createElement("td");
  // prior_url is permanent reference data (e.g. a 2024 CCND lead) — still
  // offered here regardless of checked state, including after a "Not found",
  // so it's never just gone if that judgment gets reconsidered.
  const displayUrl = row.source_url || row.prior_url || "";

  const urlWrapper = document.createElement("div");
  urlWrapper.className = "url-cell";

  // Open always present, and always follows whatever's currently in the
  // input — not a fixed snapshot of displayUrl — same live-binding pattern
  // as the metadata modal's own url fields below.
  const openLink = document.createElement("a");
  openLink.className = "open-link" + (displayUrl ? "" : " disabled");
  openLink.href = displayUrl || "#";
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "↗";
  openLink.title = "Open link";
  urlWrapper.appendChild(openLink);

  // Always editable, even once marked "not found" — that's exactly the case
  // where a prior lead (e.g. a CCND import) turned out to be dead and needs
  // replacing with the real URL, so the box can't just disappear on you.
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "paste dataset URL";
  input.id = `input-${row.row_index}`;
  input.value = displayUrl;
  input.addEventListener("input", () => {
    openLink.href = input.value || "#";
    openLink.classList.toggle("disabled", !input.value);
  });
  input.title = displayUrl;
  urlWrapper.appendChild(input);

  // A provider with several sources (e.g. bike lanes + a trails layer): the
  // box is the first one's link; "+N" lists the rest and opens the
  // metadata modal, where each source has its own block.
  const sources = row.sources || [];
  if (sources.length > 1) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more-sources";
    more.textContent = `+${sources.length - 1}`;
    more.title = sources.map((s) => `${s.source_id}: ${s.url || "(no link yet)"}`).join("\n");
    more.onclick = () => openMetadata(row);
    urlWrapper.appendChild(more);
  }

  urlTd.appendChild(urlWrapper);
  tr.appendChild(urlTd);

  // No action button here — the actual download stays a manual step (find
  // the file, drop it under data/raw/<source_id>/); this just flags whether
  // that's happened yet, same as the Metadata column's "none" convention for
  // rows not found yet.
  // Raw / Metadata: the worst status across the provider's sources; with
  // more than one, hover lists each source's own.
  const perSource = (key) =>
    sources.length > 1 ? sources.map((s) => `${s.source_id}: ${s[key]}`).join("\n") : "";

  const rawTd = document.createElement("td");
  if (row.raw_data_status === "none") {
    rawTd.innerHTML = `<span class="meta">—</span>`;
  } else {
    const badge = document.createElement("span");
    badge.className = `status status-${row.raw_data_status}`;
    badge.textContent = row.raw_data_status;
    badge.title = perSource("raw");
    rawTd.appendChild(badge);
  }
  tr.appendChild(rawTd);

  // The status pill itself opens the metadata modal ("Add" when there's
  // nothing yet) — no separate Edit button.
  const metaTd = document.createElement("td");
  if (row.metadata_status === "none") {
    metaTd.innerHTML = `<span class="meta">—</span>`;
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    const missing = row.metadata_status === "missing";
    btn.className = missing ? "metadata-btn" : `status status-${row.metadata_status} status-btn`;
    btn.textContent = missing ? "Add" : row.metadata_status;
    btn.title = perSource("metadata") || (missing ? "Add metadata" : "Edit metadata");
    btn.onclick = () => openMetadata(row);
    metaTd.appendChild(btn);
  }
  tr.appendChild(metaTd);

  tr.appendChild(notesCell(row));

  return tr;
}

// Notes column: flag reasons + status (or a "note" pill), like Home's.
// Click opens the provider modal, where the note and flag are edited.
function notesCell(row) {
  const td = document.createElement("td");
  td.className = "notes-cell";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-trigger";
  // First reason (+N for the rest), then the status — one line.
  if (row.flagged) btn.append(...compactPills(flagPills(row)), statusPill(row));
  else if (row.notes) btn.appendChild(notesPill("note", "note"));
  if (!btn.childNodes.length) {
    btn.classList.add("notes-empty");
    btn.textContent = "+ note";
  }
  btn.title = row.notes || (row.flagged ? "Flagged — no note yet" : "Add a note or flag");
  btn.addEventListener("click", () => openAddSourceModal(row));
  td.appendChild(btn);
  return td;
}

async function savePortalUrl(rowIndex, portalUrl) {
  const res = await postJson("api/portal_url", { row_index: rowIndex, portal_url: portalUrl });
  if (res.ok) {
    const row = rows.find((r) => r.row_index === rowIndex);
    if (row) row.portal_url = portalUrl;
  }
}

// Both flash the button's "confirmed" look before reloading — the reload
// often drops the row out of view entirely (e.g. the default "Unchecked"
// filter no longer matches it), so without a flash first, a successful
// click and a no-op would look identical.
async function submitFound(row, btn) {
  const input = document.getElementById(`input-${row.row_index}`);
  const errorDiv = document.getElementById(`error-${row.row_index}`);
  errorDiv.textContent = "";

  const sourceUrl = input.value.trim();

  if (!sourceUrl) {
    errorDiv.textContent = "Paste a URL first.";
    return;
  }

  const res = await postJson("api/found", { row_index: row.row_index, source_url: sourceUrl });
  if (!res.ok) {
    errorDiv.textContent = res.error || "Failed";
    return;
  }
  // Color flip is the confirmation, not a text change — appending a
  // checkmark made the button grow and get clipped in this narrow column.
  btn.classList.add("confirmed");
  setTimeout(loadRows, 700);
}

async function submitNotFound(row, btn) {
  const input = document.getElementById(`input-${row.row_index}`);
  // Keeps whatever's in the box (e.g. a PDF link) as the row's URL.
  const res = await postJson("api/not_found", { row_index: row.row_index, source_url: input.value.trim() });
  if (!res.ok) {
    document.getElementById(`error-${row.row_index}`).textContent = res.error || "Failed";
    return;
  }
  btn.classList.add("confirmed");
  setTimeout(loadRows, 700);
}

// --- Add source modal ----------------------------------------------------
// Adds a new row straight to checklist.csv only — not providers.csv (the
// master registry these came from originally). Reconciling the two is a
// separate problem for later; this just unblocks tracking a source that
// isn't in the checklist yet.

// Matches the real provider_id convention already in checklist.csv (e.g.
// "City of Calgary" + AB -> ab_calgary): strip the generic civic prefix,
// slugify what's left, prefix with the lowercased province code.
const NAME_PREFIXES = [
  "regional municipality of", "district municipality of", "municipality of",
  "government of", "city of", "town of", "county of", "region of",
  "district of", "township of", "village of",
];

function stripNamePrefix(name) {
  const lower = name.toLowerCase();
  for (const prefix of NAME_PREFIXES) {
    if (lower.startsWith(prefix + " ")) return name.slice(prefix.length + 1);
  }
  return name;
}

const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(text) {
  return text
    .normalize("NFD").replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function generateProviderId(name, province) {
  const slug = slugify(stripNamePrefix(name));
  const code = province.toLowerCase().trim();
  return code ? `${code}_${slug}` : slug;
}

const PROVINCE_OPTIONS = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"],
  ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"], ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"], ["NU", "Nunavut"], ["ON", "Ontario"],
  ["PE", "Prince Edward Island"], ["QC", "Quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
];

// Name first (so there's something to generate an id from), then id itself
// with a Generate button next to it — still freely editable either way.
// geography_level/province are real dropdowns rather than free text so
// what's typed always matches what providers.csv actually accepts.
const ADD_SOURCE_FIELDS = [
  { key: "name", label: "name", required: true },
  { key: "province", label: "province", type: "select", options: () => PROVINCE_OPTIONS },
  { key: "provider_id", label: "provider_id", required: true, genId: true },
  { key: "geography_level", label: "geography_level", required: true, type: "select", options: () => geographyLevelOptions },
  { key: "portal_url", label: "portal_url" },
  { key: "portal_license_name", label: "portal_license_name" },
  { key: "portal_license_url", label: "portal_license_url" },
  { key: "contact", label: "contact" },
];

// Note + flag, below the fields — the same flag editor as Home's popout.
const providerFlagEditor = createFlagEditor(document.getElementById("add-source-flag"), {
  hasContact: () => !!document.getElementById("add-source-field-contact")?.value.trim(),
});

// editRow is undefined when adding, or an existing row (from `rows`) when
// editing that row in place — same form either way, just pre-filled, with
// provider_id locked (it's a stable key set only once, at creation) and
// posting to update_row instead of add_row.
let editingRowIndex = null;

function openAddSourceModal(editRow) {
  editingRowIndex = editRow ? editRow.row_index : null;
  document.getElementById("add-source-title").textContent = editRow ? "Edit provider" : "Add provider";
  document.getElementById("add-source-save").textContent = editRow ? "Save" : "Add";
  document.getElementById("add-source-error").classList.add("hidden");
  document.getElementById("add-source-save-status").textContent = "";

  const form = document.getElementById("add-source-form");
  form.innerHTML = "";
  const inputs = {};

  for (const field of ADD_SOURCE_FIELDS) {
    const label = document.createElement("label");
    label.textContent = field.label + (field.required ? " *" : "");
    const description = providerFieldDescriptions[field.key];
    if (description) label.title = description;

    const row = document.createElement("div");
    row.className = "field-row";

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— choose —";
      input.appendChild(blank);
      for (const opt of field.options()) {
        const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
        const optionEl = document.createElement("option");
        optionEl.value = value;
        optionEl.textContent = text;
        input.appendChild(optionEl);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.id = `add-source-field-${field.key}`;
    input.value = editRow ? (editRow[field.key] || "") : "";
    if (field.key === "provider_id" && editRow) {
      input.disabled = true;
      input.title = "provider_id is set once at creation and can't be changed here.";
    }
    inputs[field.key] = input;

    const markRequired = () => {
      if (field.required) input.classList.toggle("required-empty", !input.value);
    };
    markRequired();
    input.addEventListener("input", markRequired);
    input.addEventListener("change", markRequired);

    row.appendChild(input);

    if (field.genId && !editRow) {
      const genBtn = document.createElement("button");
      genBtn.type = "button";
      genBtn.className = "detect-btn";
      genBtn.textContent = "Generate";
      genBtn.title = "Fill in from name + province, e.g. \"City of Calgary\" + AB -> ab_calgary";
      genBtn.onclick = () => {
        const name = inputs.name.value.trim();
        if (!name) return;
        input.value = generateProviderId(name, inputs.province.value);
        input.dispatchEvent(new Event("input"));
        checkIdCollision(input);
      };
      row.appendChild(genBtn);
    }

    label.appendChild(row);

    if (field.genId && !editRow) {
      const warning = document.createElement("div");
      warning.className = "error hidden";
      warning.id = "add-source-id-warning";
      label.appendChild(warning);
      input.addEventListener("input", () => checkIdCollision(input));
    }

    form.appendChild(label);
  }

  document.getElementById("add-source-notes").value = editRow ? editRow.notes || "" : "";
  providerFlagEditor.set(editRow || {});
  document.getElementById("add-source-modal").classList.remove("hidden");
}

function checkIdCollision(idInput) {
  const warning = document.getElementById("add-source-id-warning");
  const id = idInput.value.trim();
  const exists = id && rows.some((r) => r.provider_id === id);
  warning.textContent = exists ? `"${id}" already exists in the checklist` : "";
  warning.classList.toggle("hidden", !exists);
}

function closeAddSourceModal() {
  document.getElementById("add-source-modal").classList.add("hidden");
}

async function saveAddSource() {
  const values = {};
  for (const field of ADD_SOURCE_FIELDS) {
    values[field.key] = document.getElementById(`add-source-field-${field.key}`).value.trim();
  }
  values.notes = document.getElementById("add-source-notes").value.trim();
  Object.assign(values, providerFlagEditor.get());

  const editing = editingRowIndex !== null;
  if (editing) values.row_index = editingRowIndex;

  const errorEl = document.getElementById("add-source-error");
  const res = await postJson(editing ? "api/update_row" : "api/add_row", values);
  if (!res.ok) {
    errorEl.textContent = res.error || (editing ? "Failed to save" : "Failed to add source");
    errorEl.classList.remove("hidden");
    return;
  }
  await loadRows();
  closeAddSourceModal();
}

document.getElementById("add-source-btn").addEventListener("click", () => openAddSourceModal());
document.getElementById("add-source-close").addEventListener("click", closeAddSourceModal);
document.getElementById("add-source-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-source-modal") closeAddSourceModal();
});
document.getElementById("add-source-save").addEventListener("click", (e) => {
  e.preventDefault();
  saveAddSource();
});

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error };
  return { ok: true, ...data };
}

// --- Filters ---------------------------------------------------------------
// View dropdown + column filters/sort/search, all kept in the URL
// (view=… · f_<col>=… · q=… · sort=…) so a link reopens the same view.
const STATUS_ORDER = ["none", "missing", "partial", "complete"];
const statusLabel = (v) => (v === "none" ? "— (not found yet)" : v);

const tableFilter = createTableFilter({
  columns: {
    name: { label: "Provider", filter: false, values: () => [], sort: (r) => r.name.toLowerCase() },
    province: { label: "Prov.", values: (r) => [r.province || "—"], sort: (r) => r.province },
    level: { label: "Level", values: (r) => [r.geography_level || "—"], sort: (r) => r.geography_level },
    outcome: {
      label: "Outcome",
      values: (r) => [r.outcome || "unchecked"],
      format: (v) => ({ found: "Found", not_found: "Not found", unchecked: "Unchecked" })[v] || v,
      order: ["found", "not_found", "unchecked"],
      sort: (r) => ["found", "not_found", ""].indexOf(r.outcome),
    },
    raw: {
      label: "Raw data",
      values: (r) => [r.raw_data_status],
      format: statusLabel,
      order: STATUS_ORDER,
      sort: (r) => STATUS_ORDER.indexOf(r.raw_data_status),
    },
    metadata: {
      label: "Metadata",
      values: (r) => [r.metadata_status],
      format: statusLabel,
      order: STATUS_ORDER,
      sort: (r) => STATUS_ORDER.indexOf(r.metadata_status),
    },
    notes: notesFilterColumn((r) => r, { status: true }),
  },
  search: (r) =>
    [r.name, r.provider_id, r.province, r.geography_level, r.portal_url, r.source_url, r.prior_url, r.notes, r.contact].join(" "),
  onChange: () => render(),
});
for (const th of document.querySelectorAll("#rows th[data-col]")) tableFilter.attachHeader(th, th.dataset.col);
tableFilter.attachSearch(document.getElementById("table-search"));
tableFilter.attachSummary(document.getElementById("table-summary"));

const filterSelect = document.getElementById("filter-mode");
bindViewSelect(filterSelect, () => render());

document.getElementById("footer-file-link").addEventListener("click", () => {
  openFilePreview(document.getElementById("footer-file-link").textContent, "api/checklist/raw", "plaintext");
});
document.getElementById("file-preview-close").addEventListener("click", closeFilePreview);
document.getElementById("file-preview-modal").addEventListener("click", (e) => {
  if (e.target.id === "file-preview-modal") closeFilePreview();
});

// Deep link from Home's Metadata column (?id=<source_id>) — opens that
// source's metadata modal. (A provider link from Home is just a filter,
// ?q=<provider_id>, handled by /table-filter.js.)
async function openFromQueryParam() {
  const sourceId = new URLSearchParams(location.search).get("id");
  if (!sourceId) return;
  const row = rows.find((r) => (r.source_ids || "").split(",").map((s) => s.trim()).includes(sourceId));
  if (row) await openMetadata(row);
}

// Table header sticks right below the page header, which itself sticks
// right below the nav bar — both measured rather than hardcoded, since
// their height can reflow on resize. Nav and header are static markup (no
// fetched content), so this runs immediately rather than waiting on
// bootstrap()'s fetches — table-scroll is correctly sized to fill the
// viewport from first paint instead of jumping once data arrives.
//
// Measured via table-scroll's own boundingClientRect (plus the current
// scroll offset, to get its true document position rather than wherever
// it's currently scrolled to), not by summing up nav/header offsetHeights
// — those miss the CSS margins between nav, header and table-scroll,
// which undercounts the real space consumed above it.
//
// The footer, unlike nav/header, sizes its own dynamically-loaded content
// (the progress stat), so it isn't safe to measure this early — instead
// it's given a fixed CSS height (see .geomerge-footer), which table-scroll's
// max-height subtracts as a plain constant. Fixed also means the footer
// never resizes once its text pops in, which was the actual "jumps on
// load" bug.
function updateStickyOffsets() {
  const nav = document.querySelector(".geomerge-nav");
  const tableScroll = document.querySelector(".table-scroll");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
  if (tableScroll) {
    const topOffset = tableScroll.getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty("--header-height", `${topOffset}px`);
  }
}
window.addEventListener("resize", updateStickyOffsets);
updateStickyOffsets();

async function bootstrap() {
  await loadMeta();
  await loadRows();
  await openFromQueryParam();
}

bootstrap();
