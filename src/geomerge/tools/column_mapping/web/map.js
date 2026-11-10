const params = new URLSearchParams(location.search);
const sourceId = params.get("id");

let targets = [];
let reminderTargets = [];
let currentFlagged = false;

// table-scroll gets a real fixed height so it fills the viewport below the
// sticky header from first paint — same fix as home/collection/prep's own
// app.js, including measuring via table-scroll's own boundingClientRect
// (rather than summing nav/header offsetHeight, which misses the CSS
// margins between them). Called again at the end of load() since this
// page's header grows once source-label/file-paths actually have text —
// unlike home/prep's static filter-only header, so the pre-load measurement
// alone isn't reliably final.
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

async function load() {
  document.getElementById("source-label").innerHTML =
    `<span class="field-label">Source ID:</span> <button type="button" class="field-value source-card-trigger">${escapeHtml(sourceId)}</button>`;
  document.querySelector("#source-label .source-card-trigger").addEventListener("click", () => openSourceCard(sourceId));

  // A failed response isn't always JSON (a server-side crash the backend
  // itself didn't catch renders as an HTML error page, not {"error": ...}) —
  // res.json() throwing on that is exactly what let a previous bug make this
  // page look like it "just never loaded", with no visible error at all. Any
  // failure here — network, non-JSON body, anything — now ends in a message
  // in the table instead of silently doing nothing.
  let res, data;
  try {
    res = await fetch(`api/column_map/${encodeURIComponent(sourceId)}`);
    data = await res.json();
  } catch (e) {
    document.getElementById("rows-body").innerHTML =
      `<tr><td colspan="6" class="error">Failed to load: ${escapeHtml(String(e))}</td></tr>`;
    return;
  }
  if (!res.ok) {
    document.getElementById("rows-body").innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(data.error)}</td></tr>`;
    return;
  }

  document.getElementById("file-paths").innerHTML =
    `<span class="field-label">Loading columns from:</span> <span class="field-value">data/raw/${escapeHtml(sourceId)}/${escapeHtml(data.raw_filename)}</span>`;

  currentFlagged = !!data.flagged;
  const flagBadge = document.getElementById("flag-badge");
  flagBadge.classList.toggle("hidden", !currentFlagged);
  flagBadge.title = data.notes || "No note — add one from Home's Notes column";

  const columnMapPath = `sources/${sourceId}/column_map.yaml`;
  const fileLink = document.getElementById("footer-file-link");
  fileLink.textContent = columnMapPath;
  fileLink.onclick = () => openFilePreview(columnMapPath, `api/column_map/${encodeURIComponent(sourceId)}/raw`);

  targets = data.targets;
  reminderTargets = data.reminder_targets;

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const col of data.columns) {
    body.appendChild(renderRow(col));
  }

  recomputeCollisions();
  recomputeMissingTargets();
  loadMappedCount();
  updateStickyOffsets();
}

// Footer stat — how many sources overall have a complete column map, not
// just this one. Same /api/sources scan "Save & next" already uses to find
// the next source, so it's cheap now that status.py caches raw column
// reads (see column_mapping/status.py) — a separate, slower call before
// that fix would have made just loading this page noticeably slower for a
// number nobody's blocked on seeing immediately.
async function loadMappedCount() {
  const res = await fetch("api/sources");
  const sources = await res.json();
  const mappedCount = sources.filter((s) => s.column_map_status === "complete").length;
  document.getElementById("mapped-count").textContent = `${mappedCount} / ${sources.length} sources mapped`;
}

function renderRow(col) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = col.name;
  nameTd.title = col.name;
  tr.appendChild(nameTd);

  const typeTd = document.createElement("td");
  typeTd.className = "meta";
  typeTd.textContent = col.dtype;
  typeTd.title = col.dtype;
  tr.appendChild(typeTd);

  const nullsTd = document.createElement("td");
  nullsTd.className = "meta";
  nullsTd.textContent = col.null_count;
  tr.appendChild(nullsTd);

  const uniqueTd = document.createElement("td");
  uniqueTd.className = "meta";
  uniqueTd.textContent = col.unique_count;
  tr.appendChild(uniqueTd);

  const samplesTd = document.createElement("td");
  samplesTd.className = "meta";
  samplesTd.textContent = col.samples.join(", ");
  samplesTd.title = col.samples.join(", ");
  tr.appendChild(samplesTd);

  const targetTd = document.createElement("td");
  const select = document.createElement("select");
  select.id = `target-${cssEscape(col.name)}`;
  select.dataset.column = col.name;

  const dropOption = document.createElement("option");
  dropOption.value = "";
  dropOption.textContent = "— drop —";
  select.appendChild(dropOption);

  for (const target of targets) {
    const opt = document.createElement("option");
    opt.value = target;
    opt.textContent = target;
    select.appendChild(opt);
  }
  select.value = col.assigned || "";
  // A "saved" confidence means this value came from column_map.yaml on disk
  // (a real prior decision, possibly "deliberately left unassigned" — see
  // server.py's api_column_map_get) rather than today's rule-based guess.
  // Only non-"saved" rows are safe for refreshAutoSuggestions (below) to
  // touch after a matching-rule edit, and only while the select still shows
  // exactly what it was suggested at render time — the moment a person
  // picks anything themselves, this row is off-limits to that refresh.
  select.dataset.autoSuggested = col.confidence !== "saved";
  select.dataset.suggestedValue = col.assigned || "";
  select.addEventListener("change", () => {
    recomputeCollisions();
    recomputeMissingTargets();
  });
  targetTd.appendChild(select);

  tr.appendChild(targetTd);
  return tr;
}

// Called after a matching-rule edit (see rules-modal.js) — re-suggests only
// rows that are both rule-driven (not "saved" from disk) and still showing
// exactly what they were suggested at load, so a person's own picks (or
// picks that happen to match the old suggestion, then were deliberately
// re-confirmed) are never silently swapped out from under them. A full
// load() would be simpler but clobbers any unsaved manual selection on
// every other row too, so this only touches what a rule edit could actually
// have affected.
async function refreshAutoSuggestions() {
  const res = await fetch(`api/column_map/${encodeURIComponent(sourceId)}`);
  const data = await res.json();
  if (!res.ok) return;

  const byName = new Map(data.columns.map((col) => [col.name, col]));
  for (const select of document.querySelectorAll("select[data-column]")) {
    if (select.dataset.autoSuggested !== "true") continue;
    if (select.value !== select.dataset.suggestedValue) continue;

    const col = byName.get(select.dataset.column);
    if (!col) continue;

    select.value = col.assigned || "";
    select.dataset.autoSuggested = col.confidence !== "saved";
    select.dataset.suggestedValue = col.assigned || "";
  }

  recomputeCollisions();
  recomputeMissingTargets();
}

function recomputeCollisions() {
  const selects = [...document.querySelectorAll("select[data-column]")];
  const counts = {};
  for (const select of selects) {
    if (select.value) counts[select.value] = (counts[select.value] || 0) + 1;
  }
  let anyCollision = false;
  for (const select of selects) {
    const isCollision = select.value && counts[select.value] > 1;
    if (isCollision) anyCollision = true;
    select.closest("tr").classList.toggle("collision", isCollision);
  }

  const btn = document.getElementById("save-next-btn");
  btn.disabled = anyCollision;
  btn.title = anyCollision ? "Resolve the highlighted collisions first" : "";
}

function recomputeMissingTargets() {
  const assigned = new Set(
    [...document.querySelectorAll("select[data-column]")].map((s) => s.value).filter(Boolean)
  );
  const missing = reminderTargets.filter((t) => !assigned.has(t));

  const container = document.getElementById("missing-targets");
  if (missing.length === 0) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = `Not mapped: ${missing.join(", ")}`;
}

// Both buttons are disabled for the whole operation (not just their own
// click target) — Save & next's second phase (findNextSourcePreferUnflagged,
// below) hits the same slow /api/sources scan Flag & next would if clicked
// meanwhile, so leaving either live invites a double-submit while the first
// request is still in flight, with no visual sign anything is happening.
function setSaving(inProgress, message) {
  document.getElementById("save-next-btn").disabled = inProgress;
  document.getElementById("flag-next-btn").disabled = inProgress;
  document.getElementById("save-status").textContent = message || "";
}

// Same scan findNextSource (nav.js) does, but a flagged source is skipped in
// favor of any other still-incomplete one — the whole point of flagging a
// complex source is to come back to it last, not to have it show right back
// up on the very next "Save & next". Only once nothing unflagged is left does
// this fall back to a flagged one.
async function findNextSourcePreferUnflagged(currentId) {
  const res = await fetch("api/sources");
  const sources = await res.json();
  const isIncomplete = (s) => s.has_data && s.has_metadata && s.column_map_status !== "complete";
  const candidates = sources.filter((s) => s.source_id !== currentId && isIncomplete(s));
  const next = candidates.find((s) => !s.flagged) || candidates[0];
  return next ? next.source_id : null;
}

async function save(destination) {
  const flagging = destination === "flag";
  setSaving(true, flagging ? "Flagging…" : "Saving…");

  const assignments = {};
  for (const select of document.querySelectorAll("select[data-column]")) {
    assignments[select.dataset.column] = select.value || null;
  }

  // Every step below is wrapped, not just the save request itself — a bug
  // that made a save crash also crashed silently (res.json() throwing on an
  // HTML error page it wasn't expecting), which is exactly what turned Flag &
  // next into a button stuck forever on "Flagging…" with no way to tell it
  // had actually failed rather than still being in flight. Now any failure
  // anywhere in this flow — the save itself, or the next-source lookup after
  // it — ends in a visible message and buttons re-enabled, never a hang.
  try {
    const res = await fetch(`api/column_map/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments, flagged: flagging }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaving(false, data.error || "Failed to save");
      return;
    }

    // The slow step — findNextSourcePreferUnflagged scans every source's
    // status (see /api/sources) to find the next one still needing work,
    // which is the actual multi-second wait after clicking Save & next, not
    // the save itself. Naming it explicitly here (rather than leaving
    // "Saving…" up) is the whole fix for not knowing whether anything's
    // happening.
    setSaving(true, "Finding next source…");
    const nextSourceId = await findNextSourcePreferUnflagged(sourceId);
    if (nextSourceId) {
      location.href = `map.html?id=${encodeURIComponent(nextSourceId)}`;
    } else {
      goHome();
    }
  } catch (e) {
    setSaving(false, `Something went wrong: ${e}`);
  }
}

function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

document.getElementById("save-next-btn").addEventListener("click", () => save("next"));
document.getElementById("flag-next-btn").addEventListener("click", () => save("flag"));
load();
