// Shared by every per-source review page (column-mapping's map.html,
// classification's review.html) — these tools are always mounted under
// lode tools home, so "home" is always just "/". Loaded via an absolute
// <script src="/nav.js">, not each tool's own static folder, so there's one
// copy instead of one per tool.

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
