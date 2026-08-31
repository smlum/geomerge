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
