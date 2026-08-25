function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

function linkedCell(status, href, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.appendChild(statusBadge(status));
  td.appendChild(link);
  return td;
}

// Opens a read-only preview of metadata.yaml in a modal (see
// openMetadataModal) instead of jumping straight into collection/'s own
// edit modal in a new tab — a quick look shouldn't cost a tab, and the
// modal's own "Edit" button is right there if a look turns into an edit.
function metadataCell(status, sourceId, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  badge.classList.add("copyable");
  badge.title = "Click to view metadata.yaml";
  badge.addEventListener("click", () => openMetadataModal(sourceId));
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

// Pipeline stages (preprocessing/processing) have no review UI, but unlike
// raw/validation they do have a real CLI command that fixes them — so when
// there's something to fix (stale or never built), the badge copies that
// command to the clipboard instead of just sitting there as a status.
function pipelineCell(status, sourceId, stage, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  if (status === "stale" || status === "not_built") {
    const command = `lode pipeline ${stage} --source ${sourceId}`;
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

// Cross-blueprint fetch (collection/ owns metadata.yaml) — absolute path,
// since this page is served from "/", not "/collection/".
async function openMetadataModal(sourceId) {
  document.getElementById("metadata-modal-title").textContent = sourceId;
  document.getElementById("metadata-modal-edit").href = `collection/?id=${encodeURIComponent(sourceId)}`;
  const content = document.getElementById("metadata-modal-content");
  content.textContent = "Loading…";
  document.getElementById("metadata-modal").classList.remove("hidden");

  const res = await fetch(`/collection/api/source/${encodeURIComponent(sourceId)}/raw`);
  if (res.status === 404) {
    content.textContent = "No metadata.yaml yet for this source.";
    return;
  }
  const data = await res.json();
  content.textContent = data.content;
}

function closeMetadataModal() {
  document.getElementById("metadata-modal").classList.add("hidden");
}

document.getElementById("metadata-modal-close").addEventListener("click", closeMetadataModal);
document.getElementById("metadata-modal").addEventListener("click", (e) => {
  if (e.target.id === "metadata-modal") closeMetadataModal();
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
  nameTd.textContent = s.source_id;
  tr.appendChild(nameTd);

  // collection/ — metadata opens a read-only preview modal (see
  // metadataCell); raw is just a badge for whether the file showed up on
  // disk, no tool to click into.
  tr.appendChild(metadataCell(s.collection.metadata, s.source_id, true));
  tr.appendChild(plainCell(s.collection.raw));

  // tools/ — human-reviewed cells link into their own web UI; preprocessing
  // sits between them (mechanical, no review UI, but classification can't
  // run without it — see server.py).
  tr.appendChild(linkedCell(s.tools.column_mapping, `column-mapping/map.html?id=${encodeURIComponent(s.source_id)}`, true));
  tr.appendChild(pipelineCell(s.tools.preprocessing, s.source_id, "preprocessing"));
  tr.appendChild(linkedCell(s.tools.classification, `classification/review.html?id=${encodeURIComponent(s.source_id)}`));

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
  const nav = document.querySelector(".lode-nav");
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

async function load() {
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
