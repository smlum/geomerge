function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

// Same-tab links, deliberately — this page exists because home's
// target="_blank" cells meant a new tab per source when working through
// many in a row. Column mapping/classification's own "Save & next" already
// chains through incomplete sources in the same tab; this just fixes how
// you get there in the first place.
function linkedCell(status, href) {
  const td = document.createElement("td");
  const link = document.createElement("a");
  link.href = href;
  link.appendChild(statusBadge(status));
  td.appendChild(link);
  return td;
}

// Preprocessing has no review UI (mechanical), but unlike a plain badge it
// does have a real CLI command that fixes it — so when there's something
// to fix (stale or never built), the badge copies that command to the
// clipboard instead of just sitting there as a status. Same behavior as
// home/app.js's pipelineCell.
function preprocessingCell(status, sourceId) {
  const td = document.createElement("td");
  const badge = statusBadge(status);
  if (status === "stale" || status === "not_built") {
    const command = `geomerge pipeline preprocessing --source ${sourceId}`;
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

// Classification's status link, plus any follow-ups left on the source: its
// note (full text on hover) and a count per flag.
function classificationCell(s) {
  if (s.blocked) {
    const td = document.createElement("td");
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "status status-blocked";
    badge.textContent = `blocked · ${s.blocked.stage}`;
    badge.title = s.blocked.note || s.blocked.reason;
    badge.addEventListener("click", () => openBlockedModal(s));
    td.appendChild(badge);
    return td;
  }
  const td = linkedCell(s.classification, `/classification/review.html?id=${encodeURIComponent(s.source_id)}`);
  if (s.source_notes && !s.source_flagged) {
    const note = document.createElement("span");
    note.className = "review-marker";
    note.textContent = "note";
    note.title = s.source_notes;
    td.appendChild(note);
  }
  if (s.source_flagged) {
    const marker = document.createElement("span");
    marker.className = "review-marker review-marker-flagged";
    marker.textContent = "flagged";
    marker.title = s.source_notes || "No note";
    td.appendChild(marker);
  }
  for (const [flag, count] of Object.entries(s.classification_flag_counts)) {
    if (!count) continue;
    const marker = document.createElement("span");
    marker.className = `review-marker review-marker-${flag}`;
    marker.textContent = `${count} ${flag}`;
    td.appendChild(marker);
  }
  return td;
}

// Why a source's classification is blocked (server.py's blocked_reason):
// the stage holding it up, any note left there, and a new-tab link to that
// stage's page — or, for preprocessing, the command that unblocks it.
function openBlockedModal(s) {
  const b = s.blocked;
  document.getElementById("blocked-modal-title").textContent = s.source_id;
  document.getElementById("blocked-modal-reason").textContent = `${b.reason} — classification can't start yet`;
  const body = document.getElementById("blocked-modal-body");
  body.innerHTML = "";

  const note = document.createElement("div");
  if (b.note) {
    note.className = "blocked-note";
    note.textContent = b.note;
  } else if (b.stage === "Home") {
    note.className = "meta";
    note.textContent = "No note says why it's excluded.";
  }
  body.appendChild(note);

  const actions = document.createElement("div");
  actions.className = "blocked-actions";
  if (b.href) {
    const link = document.createElement("a");
    link.href = b.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `Open in ${b.stage} ↗`;
    actions.appendChild(link);
  }
  if (b.command) {
    const cmd = document.createElement("code");
    cmd.textContent = b.command;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyCommand(copy, b.command));
    actions.append(cmd, copy);
  }
  body.appendChild(actions);

  document.getElementById("blocked-modal").classList.remove("hidden");
}

function closeBlockedModal() {
  document.getElementById("blocked-modal").classList.add("hidden");
}

document.getElementById("blocked-modal-close").addEventListener("click", closeBlockedModal);
document.getElementById("blocked-modal").addEventListener("click", (e) => {
  if (e.target.id === "blocked-modal") closeBlockedModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBlockedModal();
});

// "Complete" means all three stages are done (or not applicable) for this
// source — same complete/not_applicable rule as home's rollups.
function isRowComplete(s) {
  return (
    (s.column_mapping === "complete" || s.column_mapping === "not_applicable") &&
    s.preprocessing === "complete" &&
    (s.classification === "complete" || s.classification === "not_applicable")
  );
}

function nameCell(sourceId) {
  const nameTd = document.createElement("td");
  nameTd.className = "name";
  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "source-card-trigger";
  nameBtn.textContent = sourceId;
  nameBtn.addEventListener("click", () => openSourceCard(sourceId));
  nameTd.appendChild(nameBtn);
  return nameTd;
}

function renderRow(s) {
  const tr = document.createElement("tr");
  tr.appendChild(nameCell(s.source_id));

  tr.appendChild(linkedCell(s.column_mapping, `/column-mapping/map.html?id=${encodeURIComponent(s.source_id)}`));
  tr.appendChild(preprocessingCell(s.preprocessing, s.source_id));
  tr.appendChild(classificationCell(s));

  return tr;
}

// table-scroll gets a real fixed height so it fills the viewport below the
// nav bar from first paint, before any rows have loaded — same fix as
// home/collection's app.js, including measuring via table-scroll's own
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
  } else if (filterMode === "follow_up") {
    visible = sources.filter(
      (s) => s.source_notes || s.source_flagged || Object.values(s.classification_flag_counts).some(Boolean)
    );
  }

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of visible) {
    body.appendChild(renderRow(s));
  }

  // Two aspects, not the blended all-three-stages complete count — that's
  // enough on its own to read as "how's review going" without also needing
  // a third combined number. Preprocessing is left out on purpose: it's
  // mechanical (no review UI, no judgment calls), unlike these two.
  // not_applicable counts as done for classification, same as isRowComplete
  // above — a source with nothing to classify isn't "still to do".
  const mappedCount = sources.filter((s) => s.column_mapping === "complete").length;
  const classifiedCount = sources.filter(
    (s) => s.classification === "complete" || s.classification === "not_applicable"
  ).length;
  // The source's own shared flag — see Home's Flagged filter for the full list.
  const flaggedCount = sources.filter((s) => s.source_flagged).length;
  document.getElementById("progress").textContent =
    `${mappedCount} / ${sources.length} mapped · ${classifiedCount} / ${sources.length} classified · ${flaggedCount} flagged`;
}

async function load() {
  sources = null;
  await loadStatusTable({
    footerId: "progress",
    nameCell,
    statusColumns: 3,
    onLoaded: (data) => {
      sources = data;
      render();
    },
  });
}

document.getElementById("refresh-btn").addEventListener("click", load);

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("prep-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;
filterSelect.addEventListener("change", () => {
  localStorage.setItem("prep-filter-mode", filterSelect.value);
  if (sources) render();
});

load();
