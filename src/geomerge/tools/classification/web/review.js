const params = new URLSearchParams(location.search);
const sourceId = params.get("id");

let appConfig = { mock: true, maps_api_key: null, street_view_enabled: false, n_samples: 3, not_included_value: "not_included" };
const sampleCache = new Map(); // key -> { points: [...], spare: [...] }
let modalEl = null;
let activeTarget = null;

function cacheKey(target, values) {
  return `${target}::${JSON.stringify(values)}`;
}

function panoLink(p) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}&heading=${p.heading}`;
}

// Maps Embed API — a plain <iframe src>, not the Maps JavaScript API. No
// script to load, no panorama object lifecycle; switching points is just
// changing the iframe's src. Per Google's published pricing this usage is
// unmetered (unlike the JS API's per-load Dynamic Street View billing) —
// worth confirming current pricing before relying on that, but either way
// it needs "Maps Embed API" enabled on the key, not "Maps JavaScript API".
function embedUrl(p) {
  const qs = new URLSearchParams({
    key: appConfig.maps_api_key,
    location: `${p.lat},${p.lng}`,
    heading: String(p.heading),
    pitch: "0",
    fov: "90",
  });
  return `https://www.google.com/maps/embed/v1/streetview?${qs.toString()}`;
}

async function fetchSamplePoints(target, values, fresh) {
  const res = await fetch(`api/sample_points/${encodeURIComponent(sourceId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, values, fresh }),
  });
  const data = await res.json();
  return { points: data.points || [], spare: data.spare_points || [] };
}

// --- Street View modal ------------------------------------------------------
// A single shared modal, built once and reused for every group — decouples
// the viewer from the table entirely (always centered, never off-screen to
// the right of a wide table), unlike the previous per-row inline panel.

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement("div");
  modalEl.className = "sv-modal hidden";
  modalEl.innerHTML = `
    <div class="sv-modal-backdrop"></div>
    <div class="sv-modal-content">
      <div class="sv-modal-header">
        <div id="sv-modal-title" class="sv-modal-title"></div>
        <button id="sv-modal-close" class="sv-modal-close" aria-label="Close">&times;</button>
      </div>
      <div id="sv-modal-body" class="sv-modal-body"></div>
    </div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector(".sv-modal-backdrop").addEventListener("click", closeModal);
  modalEl.querySelector("#sv-modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  return modalEl;
}

function closeModal() {
  if (modalEl) modalEl.classList.add("hidden");
}

function renderPoints(container, points, onRegenerate) {
  container.innerHTML = "";
  if (!points.length) {
    container.textContent = "No sample points (no matching geometry).";
    return;
  }

  const mock = appConfig.mock || !appConfig.maps_api_key;

  if (mock) {
    for (const [i, p] of points.entries()) {
      const row = document.createElement("div");
      row.className = "sv-mock-row";
      const link = document.createElement("a");
      link.href = panoLink(p);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `Sample ${i + 1}`;
      row.appendChild(link);
      container.appendChild(row);
    }
  } else {
    let idx = 0;
    const iframe = document.createElement("iframe");
    iframe.className = "sv-embed";
    iframe.loading = "lazy";
    iframe.allow = "fullscreen";
    iframe.src = embedUrl(points[idx]);
    container.appendChild(iframe);

    const nav = document.createElement("div");
    nav.className = "sv-nav";
    const label = document.createElement("span");
    label.className = "meta";
    label.textContent = `Sample ${idx + 1} / ${points.length}`;
    nav.appendChild(label);
    if (points.length > 1) {
      const next = document.createElement("button");
      next.textContent = "Next sample →";
      next.addEventListener("click", () => {
        idx = (idx + 1) % points.length;
        iframe.src = embedUrl(points[idx]);
        label.textContent = `Sample ${idx + 1} / ${points.length}`;
      });
      nav.appendChild(next);
    }
    container.appendChild(nav);
  }

  const regenBtn = document.createElement("button");
  regenBtn.className = "sv-regen-btn";
  regenBtn.textContent = "↻ Regenerate points";
  regenBtn.title = "Get different sample points (e.g. if these are old or inconclusive)";
  regenBtn.addEventListener("click", onRegenerate);
  container.appendChild(regenBtn);
}

async function openStreetView(target, group) {
  const modal = ensureModal();
  const title = modal.querySelector("#sv-modal-title");
  const body = modal.querySelector("#sv-modal-body");

  title.textContent = Object.entries(group.values)
    .map(([k, v]) => `${k}: ${v === "" ? "(blank)" : v}`)
    .join("  ·  ");
  body.textContent = "Loading…";
  modal.classList.remove("hidden");

  const key = cacheKey(target, group.values);

  async function regenerate() {
    let cached = sampleCache.get(key);
    const n = appConfig.n_samples;
    if (cached && cached.spare.length >= n) {
      cached.points = cached.spare.splice(0, n);
    } else {
      cached = await fetchSamplePoints(target, group.values, true);
      sampleCache.set(key, cached);
    }
    renderPoints(body, cached.points, regenerate);
  }

  let cached = sampleCache.get(key);
  if (!cached) {
    cached = await fetchSamplePoints(target, group.values, false);
    sampleCache.set(key, cached);
  }
  renderPoints(body, cached.points, regenerate);
}

// --- Group rows ---------------------------------------------------------

function renderGroupRow(target, group, columns, options, streetViewEnabled) {
  const tr = document.createElement("tr");
  const notIncludedValue = appConfig.not_included_value;
  const isNotIncluded = group.target === notIncludedValue;
  const initialValue = isNotIncluded ? "" : group.target || "";
  const initialMethod = group.method;

  for (const col of columns) {
    const td = document.createElement("td");
    td.className = "meta";
    const v = group.values[col] ?? "";
    td.textContent = v === "" ? "(blank)" : v;
    td.title = v;
    tr.appendChild(td);
  }

  const countTd = document.createElement("td");
  countTd.className = "meta";
  countTd.textContent = group.count;
  tr.appendChild(countTd);

  const targetTd = document.createElement("td");
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "target-field";

  let field;
  if (options) {
    field = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— choose —";
    field.appendChild(blank);
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      field.appendChild(o);
    }
  } else {
    field = document.createElement("input");
    field.type = "text";
    field.placeholder = "free text (no enum defined yet)";
  }
  field.value = initialValue;
  field.disabled = isNotIncluded;
  fieldWrap.appendChild(field);

  if (group.confidence === "exact" || group.confidence === "substring") {
    const badge = document.createElement("span");
    badge.className = `confidence confidence-${group.confidence}`;
    badge.textContent = group.confidence;
    fieldWrap.appendChild(badge);
  }
  targetTd.appendChild(fieldWrap);

  const notIncludedLabel = document.createElement("label");
  notIncludedLabel.className = "not-included-toggle";
  const notIncludedCheckbox = document.createElement("input");
  notIncludedCheckbox.type = "checkbox";
  notIncludedCheckbox.checked = isNotIncluded;
  notIncludedCheckbox.addEventListener("change", () => {
    field.disabled = notIncludedCheckbox.checked;
  });
  notIncludedLabel.appendChild(notIncludedCheckbox);
  notIncludedLabel.append(" Not included");
  targetTd.appendChild(notIncludedLabel);

  tr.appendChild(targetTd);

  const statusTd = document.createElement("td");
  const statusSpan = document.createElement("span");
  const setSaved = (method) => {
    statusSpan.className = "save-state save-state-saved";
    statusSpan.textContent = `saved (${method})`;
  };
  const setUnsaved = () => {
    statusSpan.className = "save-state save-state-unsaved";
    statusSpan.textContent = "unsaved";
  };
  group.confidence === "saved" ? setSaved(initialMethod) : setUnsaved();
  statusTd.appendChild(statusSpan);
  tr.appendChild(statusTd);

  const saveTd = document.createElement("td");
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const value = notIncludedCheckbox.checked ? notIncludedValue : field.value.trim();
    if (!value) return;
    const method = !notIncludedCheckbox.checked && value === initialValue && initialMethod === "rule" ? "rule" : "manual";
    const res = await fetch(`api/classification/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, values: group.values, target_value: value, method }),
    });
    if (res.ok) {
      setSaved(method);
      saveBtn.textContent = "Saved ✓";
      setTimeout(() => (saveBtn.textContent = "Save"), 900);
      group.confidence = "saved";
      updateTabStatus(target);
    } else {
      setUnsaved();
    }
  });
  saveTd.appendChild(saveBtn);
  tr.appendChild(saveTd);

  if (streetViewEnabled) {
    const svTd = document.createElement("td");
    const svBtn = document.createElement("button");
    svBtn.textContent = "Street View";
    svBtn.className = "sv-btn";
    svBtn.addEventListener("click", () => openStreetView(target, group));
    svTd.appendChild(svBtn);
    tr.appendChild(svTd);
  }

  return tr;
}

// --- Target sections (one per tab) --------------------------------------

const targetDataByName = {}; // target -> targetData, kept for tab status recompute after a save

// not_applicable: no source columns configured/present, or no value combos
// at all. not_started: nothing saved yet. complete: every combo has a saved
// mapping. needs_review: some but not all. Mirrors status.py's
// target_status() exactly, but derived from the groups this page already
// has in hand (each carries confidence: "saved" when it came off disk)
// rather than a second request — status.py's version exists for /api/sources,
// which needs it for every source at once, not just the one open here.
function computeTargetStatus(targetData) {
  if (!targetData.source_columns.length || !targetData.groups.length) return "not_applicable";
  const covered = targetData.groups.filter((g) => g.confidence === "saved").length;
  if (covered === 0) return "not_started";
  return covered === targetData.groups.length ? "complete" : "needs_review";
}

function updateTabStatus(target) {
  const status = computeTargetStatus(targetDataByName[target]);
  const badge = document.querySelector(`.target-tab[data-target="${target}"] .status`);
  if (badge) {
    badge.className = `status status-${status}`;
    badge.textContent = status.replace(/_/g, " ");
  }
}

function renderTargetSection(target, targetData) {
  const section = document.createElement("section");
  section.className = "target-section hidden";
  section.dataset.target = target;

  if (!targetData.source_columns.length) {
    const note = document.createElement("div");
    note.className = "meta target-na-note";
    note.textContent = "Not applicable — none of this target's configured source columns exist for this source.";
    section.appendChild(note);
    return section;
  }

  const columns = targetData.source_columns;
  const table = document.createElement("table");

  const colgroup = document.createElement("colgroup");
  for (const _ of columns) {
    const col = document.createElement("col");
    col.style.width = "200px";
    colgroup.appendChild(col);
  }
  for (const width of ["70px", "260px", "130px", "90px"]) {
    const col = document.createElement("col");
    col.style.width = width;
    colgroup.appendChild(col);
  }
  if (targetData.street_view) {
    const col = document.createElement("col");
    col.style.width = "110px";
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  }
  for (const label of ["Count", "Target", "Status", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  if (targetData.street_view) {
    const th = document.createElement("th");
    th.textContent = "Street View";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const group of targetData.groups) {
    tbody.appendChild(renderGroupRow(target, group, columns, targetData.options, targetData.street_view));
  }
  table.appendChild(tbody);

  const wrap = document.createElement("div");
  wrap.className = "table-scroll";
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

// --- Tabs -----------------------------------------------------------------

function renderTabs(targetNames) {
  const bar = document.getElementById("target-tabs");
  bar.innerHTML = "";
  for (const target of targetNames) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "target-tab";
    btn.dataset.target = target;

    const label = document.createElement("span");
    label.className = "target-tab-label";
    label.textContent = target;
    btn.appendChild(label);

    const status = computeTargetStatus(targetDataByName[target]);
    const badge = document.createElement("span");
    badge.className = `status status-${status}`;
    badge.textContent = status.replace(/_/g, " ");
    btn.appendChild(badge);

    btn.addEventListener("click", () => setActiveTarget(target));
    bar.appendChild(btn);
  }
}

function setActiveTarget(target) {
  activeTarget = target;
  for (const btn of document.querySelectorAll(".target-tab")) {
    btn.classList.toggle("active", btn.dataset.target === target);
  }
  for (const section of document.querySelectorAll(".target-section")) {
    section.classList.toggle("hidden", section.dataset.target !== target);
  }
  updateStickyOffsets();
}

// table-scroll gets a real max-height so it fills the viewport below the
// sticky header (and tab bar) without pushing the footer off-screen — same
// approach as column-mapping's map.js, measuring the currently-visible
// table-scroll's own position rather than summing nav/header offsetHeight
// (which misses the CSS margins between them).
function updateStickyOffsets() {
  const nav = document.querySelector(".geomerge-nav");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
  const tableScroll = document.querySelector(".target-section:not(.hidden) .table-scroll");
  if (tableScroll) {
    const topOffset = tableScroll.getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty("--header-height", `${topOffset}px`);
  }
}
window.addEventListener("resize", updateStickyOffsets);

function isIncomplete(s) {
  return s.has_preprocessed_data && Object.values(s.targets).some((t) => t !== "complete" && t !== "not_applicable");
}

async function loadClassifiedCount() {
  const res = await fetch("api/sources");
  const sources = await res.json();
  const rolledUp = (s) => {
    const values = Object.values(s.targets);
    if (!values.length || values.every((v) => v === "not_applicable")) return "not_applicable";
    return values.every((v) => v === "complete" || v === "not_applicable") ? "complete" : "not_complete";
  };
  const classifiedCount = sources.filter((s) => rolledUp(s) === "complete").length;
  document.getElementById("classified-count").textContent = `${classifiedCount} / ${sources.length} sources classified`;
}

async function load() {
  document.getElementById("source-label").innerHTML =
    `<span class="field-label">Source ID:</span> <button type="button" class="field-value source-card-trigger">${escapeHtml(sourceId)}</button>`;
  document.querySelector("#source-label .source-card-trigger").addEventListener("click", () => openSourceCard(sourceId));

  document.getElementById("file-paths").innerHTML =
    `<span class="field-label">Reading:</span> <span class="field-value">data/preprocessing/${escapeHtml(sourceId)}/${escapeHtml(sourceId)}.parquet</span>`;

  const classificationMapPath = `sources/${sourceId}/classification_map.yaml`;
  document.getElementById("footer-file-path").textContent = classificationMapPath;

  const [configRes, dataRes] = await Promise.all([
    fetch("api/config"),
    fetch(`api/classification/${encodeURIComponent(sourceId)}`),
  ]);
  appConfig = await configRes.json();
  const data = await dataRes.json();

  if (!dataRes.ok) {
    const err = document.getElementById("error");
    err.textContent = data.error;
    err.classList.remove("hidden");
    return;
  }

  document.getElementById("subtitle").textContent = !appConfig.street_view_enabled
    ? ""
    : appConfig.mock
      ? "Street View: mock mode — sample points shown as plain links, no API calls"
      : "Street View: embedded (Maps Embed API)";

  const container = document.getElementById("targets");
  container.innerHTML = "";
  const targetNames = Object.keys(data.targets);
  for (const target of targetNames) {
    targetDataByName[target] = data.targets[target];
    container.appendChild(renderTargetSection(target, data.targets[target]));
  }

  renderTabs(targetNames);

  // Default to the first tab that still needs work, so opening a source
  // drops you where there's something to do rather than always canbics_class.
  const firstIncomplete = targetNames.find((t) => {
    const status = computeTargetStatus(targetDataByName[t]);
    return status === "not_started" || status === "needs_review";
  });
  setActiveTarget(firstIncomplete || targetNames[0]);

  loadClassifiedCount();
}

// Every row already auto-saves itself on its own "Save" click — there's
// nothing pending to flush here, so this is just "go to the next source
// that still needs work" rather than a save step (unlike column-mapping,
// which batches a whole form and genuinely saves on this click).
document.getElementById("save-next-btn").addEventListener("click", async () => {
  const nextSourceId = await findNextSource(sourceId, "api/sources", isIncomplete);
  if (nextSourceId) {
    location.href = `review.html?id=${encodeURIComponent(nextSourceId)}`;
  } else {
    goHome();
  }
});
document.getElementById("save-back-btn").addEventListener("click", goHome);

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

load();
