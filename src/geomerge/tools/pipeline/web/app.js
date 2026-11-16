function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

// Processing has no review UI (mechanical), but unlike a plain badge it
// does have a real CLI command that fixes it — so when there's something
// to fix (stale or never built), the badge copies that command to the
// clipboard instead of just sitting there as a status. Same behavior as
// home/app.js's pipelineCell and prep/app.js's preprocessingCell.
function processingCell(status, sourceId) {
  const td = document.createElement("td");
  const badge = statusBadge(status);
  if (status === "stale" || status === "not_built") {
    const command = `geomerge pipeline processing --source ${sourceId}`;
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

function isRowComplete(s) {
  return s.processing === "complete";
}

function renderRow(s) {
  const tr = document.createElement("tr");
  tr.append(providerCell(s.provider), provinceCell(s.provider.province), sourceCell(s.source_id, s.provider.id, s.title));

  tr.appendChild(processingCell(s.processing, s.source_id));

  return tr;
}

// table-scroll gets a real fixed height so it fills the viewport below the
// nav bar from first paint, before any rows have loaded — same fix as
// home/collection/prep's app.js, including measuring via table-scroll's own
// boundingClientRect rather than summing nav/header offsetHeight (which
// misses the CSS margins between them).
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

let sources = null; // null until statuses have loaded

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  let visible = sources;
  if (filterMode === "complete") {
    visible = sources.filter(isRowComplete);
  } else if (filterMode === "incomplete") {
    visible = sources.filter((s) => !isRowComplete(s));
  }
  visible = tableFilter.apply(visible);

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of visible) {
    body.appendChild(renderRow(s));
  }

  const completeCount = sources.filter(isRowComplete).length;
  document.getElementById("progress").textContent = `${completeCount} / ${sources.length} complete`;
}

async function load() {
  sources = null;
  await loadStatusTable({
    footerId: "progress",
    nameCell: placeholderNameCells,
    statusColumns: 1,
    onLoaded: (data) => {
      sources = data;
      render();
    },
  });
}

document.getElementById("refresh-btn").addEventListener("click", load);

// --- Filters -------------------------------------------------------------------
// View dropdown + column filters/sort/search, kept in the URL (/table-filter.js).
const tableFilter = createTableFilter({
  columns: {
    provider: { label: "Provider", filter: false, values: () => [], sort: (s) => (s.provider.name || "").toLowerCase() },
    province: { label: "Prov.", values: (s) => [s.provider.province || "—"], sort: (s) => s.provider.province || "" },
    source: { label: "Source", filter: false, values: () => [], sort: (s) => (s.title || sourceLabel(s.source_id, s.provider.id)).toLowerCase() },
    status: { label: "Process", values: (s) => [s.processing], format: (v) => v.replace(/_/g, " "), sort: (s) => s.processing },
  },
  search: (s) => [s.source_id, s.title, s.provider.name, s.provider.id, s.provider.province].join(" "),
  onChange: () => sources && render(),
});
for (const th of document.querySelectorAll("#rows th[data-col]")) tableFilter.attachHeader(th, th.dataset.col);
tableFilter.attachSearch(document.getElementById("table-search"));
tableFilter.attachSummary(document.getElementById("table-summary"));

const filterSelect = document.getElementById("filter-mode");
bindViewSelect(filterSelect, () => sources && render());

load();
