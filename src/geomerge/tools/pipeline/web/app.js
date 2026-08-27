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

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = s.source_id;
  tr.appendChild(nameTd);

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

  const completeCount = sources.filter(isRowComplete).length;
  document.getElementById("progress").textContent = `${completeCount} / ${sources.length} complete`;
}

// /api/sources recomputes every source's status from scratch on every call
// (no caching yet) — with real source counts that's several seconds, and an
// empty table body during that wait looks identical to "there's just
// nothing here" or a frozen page, not "still loading". This is the whole
// fix for that: an explicit row + footer text the instant load() starts,
// not just once data arrives.
async function load() {
  document.getElementById("rows-body").innerHTML = '<tr><td colspan="2" class="meta">Loading…</td></tr>';
  document.getElementById("progress").textContent = "Loading…";
  const res = await fetch("api/sources");
  sources = await res.json();
  render();
}

document.getElementById("refresh-btn").addEventListener("click", load);

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("pipeline-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;
filterSelect.addEventListener("change", () => {
  localStorage.setItem("pipeline-filter-mode", filterSelect.value);
  render();
});

load();
