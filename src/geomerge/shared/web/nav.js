// Loaded unconditionally by every tool's page via base.html's own
// <script src="/nav.js"> (before that tool's own script), not each tool's
// own static folder — one copy instead of one per tool. These tools are
// always mounted under geomerge serve, so "home" is always just "/".

function goHome() {
  location.href = "/";
}

// Finds the next source (by this tool's own /api/sources-shaped status,
// excluding the current one) that isIncomplete(source) says still needs
// work. Returns its source_id, or null if there isn't one.
async function findNextSource(sourceId, statusUrl, isIncomplete) {
  const res = await fetch(statusUrl);
  const sources = await res.json();
  const next = sources.find((s) => s.source_id !== sourceId && isIncomplete(s));
  return next ? next.source_id : null;
}

// Byte-identical copy previously hand-typed in column-mapping/classification/
// collection's own JS — safe here now that base.html loads this file on
// every tool's page unconditionally, not just the per-source review ones.
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// The load sequence shared by the source-status dashboards (home, prep,
// pipeline, validate). Statuses usually arrive within a few frames, so the
// table waits briefly and draws once, in its final form. Only if they take
// longer (the first load after a server restart, before the status helpers'
// file caches have warmed up) do rows appear early with placeholder pills.
// Filters and the footer's counts need statuses, so onLoaded handles those.
const PLACEHOLDER_DELAY_MS = 200;

function renderPlaceholderRow(sourceId, nameCell, statusColumns, boundaryColumns) {
  const tr = document.createElement("tr");
  tr.appendChild(nameCell(sourceId));
  for (let i = 0; i < statusColumns; i++) {
    const td = document.createElement("td");
    if (boundaryColumns.includes(i)) td.classList.add("group-boundary");
    const badge = document.createElement("span");
    badge.className = "status status-loading";
    badge.textContent = "…";
    td.appendChild(badge);
    tr.appendChild(td);
  }
  return tr;
}

async function loadStatusTable({ footerId, nameCell, statusColumns, boundaryColumns = [], onLoaded }) {
  const footer = document.getElementById(footerId);
  const table = document.getElementById("rows");
  footer.textContent = "Loading statuses…";
  try {
    const idsRes = await fetch("/api/source_ids");
    const sourceIds = await idsRes.json();
    const placeholderTimer = setTimeout(() => {
      table.classList.remove("rows-pending");
      const body = document.getElementById("rows-body");
      body.innerHTML = "";
      for (const sourceId of sourceIds) {
        body.appendChild(renderPlaceholderRow(sourceId, nameCell, statusColumns, boundaryColumns));
      }
    }, PLACEHOLDER_DELAY_MS);

    const res = await fetch("api/sources");
    const data = await res.json();
    clearTimeout(placeholderTimer);
    table.classList.remove("rows-pending");
    onLoaded(data);
  } catch (e) {
    footer.textContent = `Failed to load statuses: ${e}`;
  }
}
