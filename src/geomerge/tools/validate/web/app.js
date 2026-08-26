function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

// No automated check exists yet, and no CLI command to fix it either
// (unlike processing/preprocessing) — just a badge, same as home's
// dashboard treats this column today.
function plainCell(status) {
  const td = document.createElement("td");
  td.appendChild(statusBadge(status));
  return td;
}

// Always false for now — "not_built" is a permanent placeholder (no
// automated check exists yet, see server.py), so nothing can be "complete"
// until a real check is wired up.
function isRowComplete(s) {
  return s.validation === "complete";
}

function renderRow(s) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = s.source_id;
  tr.appendChild(nameTd);

  tr.appendChild(plainCell(s.validation));

  return tr;
}

// table-scroll gets a real fixed height so it fills the viewport below the
// nav bar from first paint, before any rows have loaded — same fix as
// home/collection/prep/pipeline's app.js, including measuring via
// table-scroll's own boundingClientRect rather than summing nav/header
// offsetHeight (which misses the CSS margins between them).
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

async function load() {
  const res = await fetch("api/sources");
  sources = await res.json();
  render();
}

document.getElementById("refresh-btn").addEventListener("click", load);

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("validate-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;
filterSelect.addEventListener("change", () => {
  localStorage.setItem("validate-filter-mode", filterSelect.value);
  render();
});

load();
