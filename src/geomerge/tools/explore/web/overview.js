// Explore → Overview. Everything comes from two endpoints: /api/overview
// (headline, sources, column profile — cached server-side per merged file
// and filter set) and /api/breakdown (one geography x field matrix,
// fetched per selection). Absolute /explore/api paths, same as other tools'
// cross-page fetches.
//
// Filters: clicking a geography value (a province, provider or source)
// narrows the whole page to it. They live in the page URL as plain params
// (?source_id=on_ottawa_cycling), passed straight through to both
// endpoints, so any filtered view is linkable — the source card links here.
//
// Measured in km only: segment counts mostly reflect how each city happens
// to split its lines, not how much network there is.

const state = { geo: null, field: null, bars: "share", filters: {} };
let overviewData = null;
let breakdownData = null;

const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// A series' fill as two custom properties, light and dark (style.css picks
// one per [data-theme]): a configured colour (explore.colors) if it has
// one, else its categorical slot / Other / None.
function seriesFill(series) {
  if (series.color) return `--cl:${series.color[0]};--cd:${series.color[1]};`;
  const v = `var(--series-${series.slot})`;
  return `--cl:${v};--cd:${v};`;
}

// Per-viewer convenience only (remembered selections) — the page works the
// same without it, e.g. in a private window.
function remember(key, value) {
  try {
    localStorage.setItem(`explore-${key}`, value);
  } catch (e) {
    /* storage unavailable */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(`explore-${key}`);
  } catch (e) {
    return null;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function swatch(series) {
  return el("span", { class: "swatch", style: seriesFill(series) });
}

function showError(message, withClear = false) {
  const node = document.getElementById("error");
  node.innerHTML = "";
  node.append(message);
  if (withClear) {
    const btn = el("button", { type: "button", class: "link-btn" }, "Clear filters");
    btn.addEventListener("click", () => setFilters({}));
    node.append(" ", btn);
  }
  node.classList.remove("hidden");
}

function clearError() {
  document.getElementById("error").classList.add("hidden");
}

// --- Filters -----------------------------------------------------------------

// Geography columns in config order, broad → narrow (province, provider,
// source); detail columns (source_class, ...) come after, unfilterable.
function filterableColumns() {
  return (overviewData?.geographies || []).map((g) => g.column);
}

function byOptions() {
  return [...(overviewData?.geographies || []), ...(overviewData?.detail_columns || [])];
}

function columnLabel(column) {
  return byOptions().find((o) => o.column === column)?.label || column;
}

function filtersFromUrl() {
  const filters = {};
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (v) filters[k] = v;
  }
  return filters;
}

function filterQuery(extra = {}) {
  return new URLSearchParams({ ...state.filters, ...extra }).toString();
}

// After filtering on a geography, break down one level finer: province →
// provider → source → the first detail column (raw source_class).
function stepDownFrom(column) {
  const options = byOptions().map((o) => o.column);
  const i = options.indexOf(column);
  return i >= 0 && i + 1 < options.length ? options[i + 1] : null;
}

function setFilters(filters, { stepFrom = null, push = true } = {}) {
  state.filters = filters;
  if (stepFrom) {
    const next = stepDownFrom(stepFrom);
    if (next) state.geo = next;
  }
  if (push) history.pushState(null, "", `${location.pathname}${Object.keys(filters).length ? "?" + filterQuery() : ""}`);
  load();
}

function addFilter(column, value) {
  setFilters({ ...state.filters, [column]: value }, { stepFrom: column });
}

function removeFilter(column) {
  const next = { ...state.filters };
  delete next[column];
  setFilters(next);
}

function renderFilterBar() {
  const bar = document.getElementById("filters");
  bar.innerHTML = "";
  const entries = Object.entries(state.filters);
  bar.classList.toggle("hidden", entries.length === 0);
  if (!entries.length) return;
  bar.append(el("span", { class: "meta" }, "Showing only"));
  for (const [column, value] of entries) {
    const remove = el("button", { type: "button", class: "chip-remove", title: "Remove filter", "aria-label": `Remove ${value}` }, "×");
    remove.addEventListener("click", () => removeFilter(column));
    const chip = el("span", { class: "chip" }, el("span", { class: "chip-key" }, columnLabel(column)), value, remove);
    if (column === "source_id") chip.insertBefore(infoButton(value), remove);
    bar.append(chip);
  }
  if (entries.length > 1) {
    const all = el("button", { type: "button", class: "link-btn" }, "Clear all");
    all.addEventListener("click", () => setFilters({}));
    bar.append(all);
  }
}

// A value that filters the page when clicked (and, for a source, a ⓘ that
// opens the shared pipeline-status card instead).
function filterLink(column, value) {
  const wrap = el("span", { class: "filter-cell" });
  const btn = el("button", { type: "button", class: "filter-link", title: `Show only ${value}` }, value);
  btn.addEventListener("click", () => addFilter(column, value));
  wrap.append(btn);
  if (column === "source_id") wrap.append(infoButton(value));
  return wrap;
}

function infoButton(sourceId) {
  const btn = el("button", { type: "button", class: "info-btn", title: "Pipeline status", "aria-label": `Pipeline status for ${sourceId}` }, "ⓘ");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSourceCard(sourceId);
  });
  return btn;
}

// --- Tooltip -----------------------------------------------------------------

const tooltip = document.getElementById("tooltip");

function showTooltip(event, content) {
  tooltip.innerHTML = "";
  tooltip.append(content);
  tooltip.classList.remove("hidden");
  moveTooltip(event);
}

function moveTooltip(event) {
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.classList.add("hidden");
}

// --- Headline ----------------------------------------------------------------

function renderHeadline(h) {
  const tiles = [
    [nf0.format(h.km), "km of network"],
    [nf0.format(h.sources), "sources"],
    [nf0.format(h.providers), "providers"],
    [nf0.format(h.provinces), "provinces"],
    [`${nf1.format(h.primary_classified_pct)}%`, `of km with a ${h.primary_field}`],
  ];
  const container = document.getElementById("headline");
  container.innerHTML = "";
  for (const [value, label] of tiles) {
    container.append(el("div", { class: "tile" }, el("div", { class: "tile-value" }, value), el("div", { class: "tile-label" }, label)));
  }
}

// --- Breakdown ---------------------------------------------------------------

function populateSelects(data) {
  const geoSelect = document.getElementById("geo-select");
  const fieldSelect = document.getElementById("field-select");
  geoSelect.innerHTML = "";
  fieldSelect.innerHTML = "";
  for (const o of byOptions()) geoSelect.append(el("option", { value: o.column }, o.label));
  for (const f of data.fields) fieldSelect.append(el("option", { value: f.name }, f.name));

  const geoOptions = byOptions().map((o) => o.column);
  const fieldOptions = data.fields.map((f) => f.name);
  if (!geoOptions.includes(state.geo)) {
    const savedGeo = recall("geo");
    state.geo = geoOptions.includes(savedGeo) ? savedGeo : geoOptions[0];
  }
  if (!fieldOptions.includes(state.field)) {
    const savedField = recall("field");
    state.field = fieldOptions.includes(savedField) ? savedField : data.primary_field || fieldOptions[0];
  }
  state.bars = recall("bars") === "absolute" ? "absolute" : "share";
  geoSelect.value = state.geo;
  fieldSelect.value = state.field;
  syncBarButtons();
}

function syncBarButtons() {
  for (const btn of document.querySelectorAll("[data-bars]")) {
    btn.classList.toggle("active", btn.dataset.bars === state.bars);
  }
}

async function loadBreakdown() {
  const res = await fetch(`/explore/api/breakdown?${filterQuery({ geo: state.geo, field: state.field })}`);
  const data = await res.json();
  if (!res.ok) {
    showError(data.error || "Failed to load breakdown");
    return;
  }
  breakdownData = data;
  renderBreakdown();
}

function renderBreakdown() {
  // Series with no km in the current (possibly filtered) data are left out —
  // colours are fixed per value, so dropping one never repaints the rest.
  const data = { ...breakdownData, series: breakdownData.series.filter((s) => (breakdownData.totals[s.key]?.km || 0) > 0) };
  const geoLabel = columnLabel(data.geo);
  const grand = Object.values(data.totals).reduce((sum, t) => sum + t.km, 0);
  const canFilter = filterableColumns().includes(data.geo);

  const table = document.getElementById("breakdown-table");
  table.innerHTML = "";
  const headRow = el("tr", {}, el("th", {}, geoLabel), el("th", { class: "num" }, "Total km"), el("th", { class: "bar-cell" }, ""));
  for (const s of data.series) {
    headRow.append(el("th", { class: "num series-col", title: s.key }, el("span", { class: "legend-item" }, swatch(s), s.label)));
  }
  table.append(el("thead", {}, headRow));

  const maxRow = Math.max(...data.rows.map((r) => r.km), 1);
  const tbody = el("tbody");
  for (const row of data.rows) {
    const label = canFilter ? filterLink(data.geo, row.geo) : el("span", { class: "raw-value", title: row.geo }, row.geo);
    // share: every bar full width, to compare the mix across rows of very
    // different size; absolute: length ∝ the row's total, to compare size.
    const width = state.bars === "share" ? 100 : (100 * row.km) / maxRow;
    const stack = el("div", { class: "stack", style: `width:${width}%` });
    for (const s of data.series) {
      const v = row.values[s.key]?.km || 0;
      if (!v) continue;
      // Grow factors normalised to the row (sum 1000): raw km would leave a
      // row totalling under 1 km short of full width, since flex only
      // distributes free space in proportion when the factors sum to ≥ 1.
      const seg = el("div", { class: "stack-seg", style: `flex:${(1000 * v) / row.km} 0 0;${seriesFill(s)}` });
      seg.addEventListener("mouseenter", (e) => showTooltip(e, segmentTooltip(row, s)));
      seg.addEventListener("mousemove", moveTooltip);
      seg.addEventListener("mouseleave", hideTooltip);
      stack.append(seg);
    }
    const tr = el("tr", {}, el("td", { class: "geo-cell" }, label), el("td", { class: "num" }, nf1.format(row.km)), el("td", { class: "bar-cell" }, stack));
    for (const s of data.series) {
      const v = row.values[s.key]?.km || 0;
      tr.append(el("td", { class: v ? "num" : "num muted" }, v ? nf1.format(v) : "–"));
    }
    tbody.append(tr);
  }
  table.append(tbody);

  const footRow = el("tr", {}, el("td", {}, `${data.rows.length} ${geoLabel.toLowerCase()} values`), el("td", { class: "num" }, nf1.format(grand)), el("td"));
  // Totals double as the legend's figures: km plus share of the whole (the
  // header row carries each series' swatch + name).
  for (const s of data.series) {
    const total = data.totals[s.key]?.km || 0;
    const pct = grand ? (100 * total) / grand : 0;
    footRow.append(el("td", { class: "num" }, nf1.format(total), el("div", { class: "total-share" }, `${nf1.format(pct)}%`)));
  }
  table.append(el("tfoot", {}, footRow));
}

function segmentTooltip(row, series) {
  const v = row.values[series.key];
  const share = row.km ? (100 * v.km) / row.km : 0;
  return el("div", {},
    el("div", { class: "tt-title" }, row.geo),
    el("div", { class: "tt-row" }, swatch(series), el("span", {}, series.label), el("span", {}, `${nf1.format(v.km)} km`)),
    el("div", { class: "tt-row muted" }, el("span", {}, `share of ${row.geo}`), el("span", {}, `${nf1.format(share)}%`)));
}

// --- Sources -----------------------------------------------------------------

const SOURCE_COLUMNS = [
  { key: "source_id", label: "Source" },
  { key: "provider_name", label: "Provider" },
  { key: "province", label: "Prov." },
  { key: "km", label: "km", num: true, fmt: (v) => nf1.format(v) },
  { key: "max_km", label: "Longest seg. (km)", num: true, fmt: (v) => nf1.format(v) },
  { key: "primary_blank_pct", label: "No class (% km)", num: true, fmt: (v) => (v ? `${nf1.format(v)}%` : "–") },
];
let sourceSort = { key: "km", desc: true };

function renderSources() {
  const rows = [...overviewData.sources].sort((a, b) => {
    const av = a[sourceSort.key] ?? "";
    const bv = b[sourceSort.key] ?? "";
    const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
    return sourceSort.desc ? -cmp : cmp;
  });

  const table = document.getElementById("sources-table");
  table.innerHTML = "";
  const headRow = el("tr");
  for (const col of SOURCE_COLUMNS) {
    const arrow = sourceSort.key === col.key ? (sourceSort.desc ? " ↓" : " ↑") : "";
    const th = el("th", { class: `sortable${col.num ? " num" : ""}${arrow ? " sorted" : ""}` }, col.label + arrow);
    th.addEventListener("click", () => {
      sourceSort = sourceSort.key === col.key ? { key: col.key, desc: !sourceSort.desc } : { key: col.key, desc: !!col.num };
      renderSources();
    });
    headRow.append(th);
  }
  table.append(el("thead", {}, headRow));

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const col of SOURCE_COLUMNS) {
      if (col.key === "source_id") tr.append(el("td", {}, filterLink("source_id", r.source_id)));
      else tr.append(el("td", { class: col.num ? "num" : "" }, col.fmt ? col.fmt(r[col.key]) : r[col.key] ?? "–"));
    }
    tbody.append(tr);
  }
  table.append(tbody);
}

// --- Column profile ----------------------------------------------------------

function fillCell(pct) {
  return el("td", { class: "num" },
    el("span", { class: "fill-meter" }, el("span", { style: `width:${pct}%` })),
    `${nf1.format(pct)}%`);
}

function renderProfile() {
  const table = document.getElementById("profile-table");
  table.innerHTML = "";
  table.append(el("thead", {}, el("tr", {},
    el("th", {}, ""), el("th", {}, "Column"), el("th", {}, "Kind"),
    el("th", { class: "num" }, "Filled (rows)"), el("th", { class: "num" }, "Filled (km)"),
    el("th", { class: "num" }, "Distinct"), el("th", {}, "Summary"))));

  const tbody = el("tbody");
  for (const p of overviewData.profile) {
    let summary;
    if (p.kind === "numeric" && p.min !== undefined) {
      summary = `min ${nf1.format(p.min)} · median ${nf1.format(p.median)} · max ${nf1.format(p.max)}`;
    } else if (p.mostly_unique) {
      summary = "mostly unique (an id?)";
    } else if (p.top?.length) {
      summary = p.top.slice(0, 3).map((t) => t.value).join(" · ");
    } else {
      summary = "empty";
    }

    const expandable = p.top?.length > 0;
    const btn = expandable ? el("button", { type: "button", class: "expand-btn", "aria-expanded": "false", title: "Top values" }, "▸") : null;
    const kindLabel = p.in_schema ? p.kind : `${p.kind} · not in schema`;
    tbody.append(el("tr", {},
      el("td", {}, btn), el("td", {}, p.name), el("td", {}, el("span", { class: "kind" }, kindLabel)),
      fillCell(p.filled_pct), fillCell(p.filled_km_pct),
      el("td", { class: "num" }, nf0.format(p.distinct)), el("td", { class: "muted" }, summary)));

    if (expandable) {
      const grid = el("div", { class: "top-values" },
        el("strong", {}, "Top values"), el("strong", { class: "num" }, "% km"), el("strong", { class: "num" }, "% rows"));
      for (const t of p.top) {
        grid.append(el("span", { class: "value", title: t.value }, t.value),
          el("span", { class: "num" }, `${nf1.format(t.km_pct)}%`), el("span", { class: "num" }, `${nf1.format(t.rows_pct)}%`));
      }
      const detail = el("tr", { class: "profile-detail hidden" }, el("td"), el("td", { colspan: "6" }, grid));
      btn.addEventListener("click", () => {
        const open = detail.classList.toggle("hidden") === false;
        btn.textContent = open ? "▾" : "▸";
        btn.setAttribute("aria-expanded", String(open));
      });
      tbody.append(detail);
    }
  }
  table.append(tbody);
}

// --- Wiring ------------------------------------------------------------------

document.getElementById("geo-select").addEventListener("change", (e) => {
  state.geo = e.target.value;
  remember("geo", state.geo);
  loadBreakdown();
});

document.getElementById("field-select").addEventListener("change", (e) => {
  state.field = e.target.value;
  remember("field", state.field);
  loadBreakdown();
});

for (const btn of document.querySelectorAll("[data-bars]")) {
  btn.addEventListener("click", () => {
    state.bars = btn.dataset.bars;
    remember("bars", state.bars);
    syncBarButtons();
    if (breakdownData) renderBreakdown();
  });
}

// Back/forward walks through filter history like ordinary pages.
window.addEventListener("popstate", () => setFilters(filtersFromUrl(), { push: false }));

function updateNavHeight() {
  const nav = document.querySelector(".geomerge-nav");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
}
window.addEventListener("resize", updateNavHeight);
updateNavHeight();

async function load() {
  clearError();
  renderFilterBar();
  let res, data;
  try {
    res = await fetch(`/explore/api/overview?${filterQuery()}`);
    data = await res.json();
  } catch (e) {
    showError(`Failed to load: ${e}`);
    return;
  }
  if (!res.ok) {
    showError(data.error || "Failed to load", Object.keys(state.filters).length > 0);
    return;
  }
  overviewData = data;
  // Only filters the server recognised (a geography column) count — drop
  // anything else that was in the URL.
  state.filters = data.filters;
  renderFilterBar();

  const modified = new Date(data.data_modified * 1000).toLocaleString();
  document.getElementById("data-label").textContent = `${data.data_path} · merged ${modified}`;
  document.getElementById("footer-stats").textContent =
    `${nf0.format(data.headline.km)} km · ${data.headline.sources} sources`;

  renderHeadline(data.headline);
  populateSelects(data);
  renderSources();
  renderProfile();
  await loadBreakdown();
}

// A deep link (?source_id=...) starts one level below its narrowest filter,
// same as clicking it would — worked out after the first load, once the
// configured geography order is known.
(async () => {
  state.filters = filtersFromUrl();
  await load();
  if (!overviewData) return;
  const deepest = filterableColumns().filter((c) => state.filters[c]).pop();
  const next = deepest && stepDownFrom(deepest);
  if (next && next !== state.geo) {
    state.geo = next;
    document.getElementById("geo-select").value = next;
    await loadBreakdown();
  }
})();
