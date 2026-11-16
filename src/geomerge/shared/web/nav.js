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
  // Forward from the current source, wrapping around, rather than the first
  // incomplete overall: that would keep returning to any source left unfinished
  // earlier in the list.
  const start = sources.findIndex((s) => s.source_id === sourceId);
  const ordered = [...sources.slice(start + 1), ...sources.slice(0, Math.max(start, 0))];
  const next = ordered.find(isIncomplete);
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

// --- Provider / Prov. / Source cells -----------------------------------------
// Every source dashboard's first three columns. Provider opens the provider
// card (or links to Collect where the page has no card); Source shows the
// dataset_title, else the part of the id after the provider's ("trails" for
// ab_calgary_trails), full id on hover, and opens the source card. Rows carry
// provider: {id, name, province} and title from the server
// (collection/status.py's source_provider/source_title).
function providerCell(provider) {
  const td = document.createElement("td");
  td.className = "name";
  if (!provider || !provider.id) return td;
  // Opens the provider card where the page has the card modal; otherwise a
  // link to the provider's rows in Collect.
  const hasCard = typeof openProviderCard === "function";
  const el = document.createElement(hasCard ? "button" : "a");
  el.className = "provider-link";
  el.textContent = provider.name || provider.id;
  el.title = `${provider.name || provider.id} (${provider.id})`;
  if (hasCard) {
    el.type = "button";
    el.addEventListener("click", () => openProviderCard(provider.id));
  } else {
    el.href = `/collection/?q=${encodeURIComponent(provider.id)}`;
  }
  td.appendChild(el);
  return td;
}

function provinceCell(province) {
  const td = document.createElement("td");
  td.className = "meta-cell";
  td.textContent = province || "—";
  return td;
}

function sourceLabel(sourceId, providerId) {
  return providerId && sourceId.startsWith(`${providerId}_`) ? sourceId.slice(providerId.length + 1) : sourceId;
}

function sourceCell(sourceId, providerId, title = "") {
  const td = document.createElement("td");
  td.className = "name";
  const hasCard = typeof openSourceCard === "function";
  const el = document.createElement(hasCard ? "button" : "span");
  el.className = "source-card-trigger";
  // The publisher's dataset title when recorded, else the id's label.
  el.textContent = title || sourceLabel(sourceId, providerId);
  el.title = title ? `${title} — ${sourceId}` : sourceId;
  if (hasCard) {
    el.type = "button";
    el.addEventListener("click", () => openSourceCard(sourceId));
  }
  td.appendChild(el);
  return td;
}

// While statuses load (nav.js's placeholder rows): blank Provider and
// Prov., then the full id.
function placeholderNameCells(sourceId) {
  const frag = document.createDocumentFragment();
  frag.append(providerCell(null), provinceCell(""), sourceCell(sourceId, ""));
  return frag;
}
