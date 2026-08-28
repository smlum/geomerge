function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

// Every source-owned YAML file (metadata.yaml, column_map.yaml,
// classification_map.yaml) gets the same treatment: clicking the status pill
// opens a read-only preview in a modal (see openYamlModal) instead of
// jumping straight into that tool's own edit UI in a new tab — a quick look
// shouldn't cost a tab, and the modal's own "Edit" button is right there if
// a look turns into an edit.
// accent matches the nav tab that owns each file (see nav.css's .tab-*):
// metadata -> Collect, column_map/classification_map -> Prepare (the
// dedicated tab for both stages — see prep/'s server.py docstring).
const YAML_PREVIEWS = {
  metadata: {
    filename: "metadata.yaml",
    fetchUrl: (id) => `/collection/api/source/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `collection/?id=${encodeURIComponent(id)}`,
    accent: "peach",
  },
  column_map: {
    filename: "column_map.yaml",
    fetchUrl: (id) => `/column-mapping/api/column_map/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `column-mapping/map.html?id=${encodeURIComponent(id)}`,
    accent: "purple",
  },
  classification_map: {
    filename: "classification_map.yaml",
    fetchUrl: (id) => `/classification/api/classification/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `classification/review.html?id=${encodeURIComponent(id)}`,
    accent: "purple",
  },
};

function yamlPreviewCell(status, sourceId, kind, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  badge.classList.add("copyable");
  badge.title = `Click to view ${YAML_PREVIEWS[kind].filename}`;
  badge.addEventListener("click", () => openYamlModal(kind, sourceId));
  td.appendChild(badge);
  return td;
}

// No tool exists yet for this stage — a badge, not a link, so there's
// nothing to click through to.
function plainCell(status, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  td.appendChild(statusBadge(status));
  return td;
}

// Raw has no editor of its own, but "complete" means a file's actually sat
// down on disk somewhere — worth a click to confirm exactly where without
// digging through data/raw/ by hand. "missing" stays a plain, inert badge
// (see plainCell) since there's nothing to show.
function rawInfoCell(status, sourceId, rawFilename, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  if (status === "complete") {
    badge.classList.add("copyable");
    badge.title = "Click to view raw file location";
    badge.addEventListener("click", () => openRawInfoModal(sourceId, rawFilename));
  }
  td.appendChild(badge);
  return td;
}

function openRawInfoModal(sourceId, rawFilename) {
  document.getElementById("raw-modal-title").textContent = sourceId;
  document.getElementById("raw-modal-path").textContent = `data/raw/${sourceId}/${rawFilename}`;
  document.getElementById("raw-modal").classList.remove("hidden");
}

function closeRawInfoModal() {
  document.getElementById("raw-modal").classList.add("hidden");
}

document.getElementById("raw-modal-close").addEventListener("click", closeRawInfoModal);
document.getElementById("raw-modal").addEventListener("click", (e) => {
  if (e.target.id === "raw-modal") closeRawInfoModal();
});

// Pipeline stages (preprocessing/processing) have no review UI, but unlike
// raw/validation they do have a real CLI command that fixes them — so when
// there's something to fix (stale or never built), the badge copies that
// command to the clipboard instead of just sitting there as a status.
function pipelineCell(status, sourceId, stage, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  if (status === "stale" || status === "not_built") {
    const command = `geomerge pipeline ${stage} --source ${sourceId}`;
    badge.classList.add("copyable");
    badge.title = "Click to copy command";
    badge.addEventListener("click", () => copyCommand(badge, command));
  }
  td.appendChild(badge);
  return td;
}

async function copyCommand(badge, command) {
  try {
    await navigator.clipboard.writeText(command);
  } catch (e) {
    return;
  }
  const original = badge.textContent;
  badge.textContent = "copied!";
  setTimeout(() => {
    badge.textContent = original;
  }, 1000);
}

// Cross-blueprint fetch (each tool owns its own YAML file) — absolute path,
// since this page is served from "/", not from that tool's own prefix.
async function openYamlModal(kind, sourceId) {
  const preview = YAML_PREVIEWS[kind];
  document.getElementById("yaml-modal-title").textContent = sourceId;
  document.getElementById("yaml-modal-path").textContent = "";
  const editBtn = document.getElementById("yaml-modal-edit");
  editBtn.href = preview.editHref(sourceId);
  editBtn.className = `edit-btn edit-btn-${preview.accent}`;
  const content = document.getElementById("yaml-modal-content");
  content.textContent = "Loading…";
  document.getElementById("yaml-modal").classList.remove("hidden");

  const res = await fetch(preview.fetchUrl(sourceId));
  if (res.status === 404) {
    content.textContent = `No ${preview.filename} yet for this source.`;
    return;
  }
  const data = await res.json();
  document.getElementById("yaml-modal-path").textContent = data.path;
  content.innerHTML = hljs.highlight(data.content, { language: "yaml" }).value;
}

function closeYamlModal() {
  document.getElementById("yaml-modal").classList.add("hidden");
}

document.getElementById("yaml-modal-close").addEventListener("click", closeYamlModal);
document.getElementById("yaml-modal").addEventListener("click", (e) => {
  if (e.target.id === "yaml-modal") closeYamlModal();
});

// "Complete" means nothing left to do anywhere in the row — every stage
// is either complete or not applicable. Validation is deliberately
// excluded: it's a permanent "not_built" placeholder (see server.py, no
// automated check exists yet), so including it would mean no row could
// ever be "complete".
function isRowComplete(s) {
  const statuses = [
    s.collection.metadata,
    s.collection.raw,
    s.tools.column_mapping,
    s.tools.preprocessing,
    s.tools.classification,
    s.pipeline.processing,
  ];
  return statuses.every((st) => st === "complete" || st === "not_applicable");
}

function renderRow(s) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "source-card-trigger";
  nameBtn.textContent = s.source_id;
  nameBtn.addEventListener("click", () => openSourceCard(s.source_id));
  nameTd.appendChild(nameBtn);
  tr.appendChild(nameTd);

  // collection/ — metadata opens a read-only preview modal (see
  // yamlPreviewCell); raw is just a badge for whether the file showed up on
  // disk, no tool to click into.
  tr.appendChild(yamlPreviewCell(s.collection.metadata, s.source_id, "metadata", true));
  tr.appendChild(rawInfoCell(s.collection.raw, s.source_id, s.collection.raw_filename));

  // tools/ — column_map.yaml and classification_map.yaml get the same
  // read-only preview treatment as metadata.yaml (see yamlPreviewCell);
  // preprocessing sits between them (mechanical, no review UI, but
  // classification can't run without it — see server.py).
  tr.appendChild(yamlPreviewCell(s.tools.column_mapping, s.source_id, "column_map", true));
  tr.appendChild(pipelineCell(s.tools.preprocessing, s.source_id, "preprocessing"));
  tr.appendChild(yamlPreviewCell(s.tools.classification, s.source_id, "classification_map"));

  // pipeline/ — mechanical, no review UI to link into yet.
  tr.appendChild(pipelineCell(s.pipeline.processing, s.source_id, "processing", true));
  tr.appendChild(plainCell(s.pipeline.validation));

  return tr;
}

// table-scroll gets a real fixed height (not just max-height) so it fills
// the viewport below the nav bar from first paint, before any rows have
// loaded — matching collection/app.js's updateHeaderOffset, including the
// same fix for the same bug: measuring via table-scroll's own
// boundingClientRect rather than summing nav's offsetHeight, since the
// latter misses the CSS margin between nav and table-scroll. The footer
// below is a fixed height in CSS (see style.css), not measured, so it
// doesn't need accounting for here beyond the literal 3rem already baked
// into the max-height calc there.
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

let sources = [];

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  let visible = sources;
  if (filterMode === "complete") {
    visible = sources.filter(isRowComplete);
  } else if (filterMode === "incomplete") {
    visible = sources.filter((s) => !isRowComplete(s));
  }

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of visible) {
    body.appendChild(renderRow(s));
  }

  // About this table's own rows (every stage, not just one), not the
  // provider-checklist-level "X checked, Y found" stat collection's page
  // already covers — same completeness rule as the Complete/Incomplete
  // filter above, independent of whatever filter is currently selected.
  const completeCount = sources.filter(isRowComplete).length;
  document.getElementById("summary").textContent = `${completeCount} / ${sources.length} sources complete`;
}

// /api/sources recomputes every source's status from scratch on every call
// (no caching yet) — with real source counts that's several seconds, and an
// empty table body during that wait looks identical to "there's just
// nothing here" or a frozen page, not "still loading". This is the whole
// fix for that: an explicit row + footer text the instant load() starts,
// not just once data arrives.
async function load() {
  document.getElementById("rows-body").innerHTML = '<tr><td colspan="8" class="meta">Loading…</td></tr>';
  document.getElementById("summary").textContent = "Loading…";
  const res = await fetch("api/sources");
  sources = await res.json();
  render();
}

document.getElementById("refresh-btn").addEventListener("click", load);

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("home-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;
filterSelect.addEventListener("change", () => {
  localStorage.setItem("home-filter-mode", filterSelect.value);
  render();
});

load();
