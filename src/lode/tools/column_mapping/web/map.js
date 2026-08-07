const params = new URLSearchParams(location.search);
const sourceId = params.get("id");

let targets = [];
let reminderTargets = [];

async function load() {
  document.getElementById("title").textContent = sourceId;

  const res = await fetch(`/api/column_map/${encodeURIComponent(sourceId)}`);
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("rows-body").innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(data.error)}</td></tr>`;
    return;
  }

  document.getElementById("raw-path").textContent = `data/raw/${sourceId}/${data.raw_filename} (${data.format})`;
  targets = data.targets;
  reminderTargets = data.reminder_targets;

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const col of data.columns) {
    body.appendChild(renderRow(col));
  }

  document.getElementById("width-unit").value = data.width_unit || "";
  recomputeCollisions();
  recomputeMissingTargets();
  updateWidthUnitVisibility();
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
  select.addEventListener("change", () => {
    recomputeCollisions();
    recomputeMissingTargets();
    updateWidthUnitVisibility();
  });
  targetTd.appendChild(select);

  if (col.confidence && col.confidence !== "saved" && col.confidence !== "none") {
    const badge = document.createElement("span");
    badge.className = `confidence confidence-${col.confidence}`;
    badge.textContent = col.confidence;
    targetTd.appendChild(badge);
  }

  tr.appendChild(targetTd);
  return tr;
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

  const title = anyCollision ? "Resolve the highlighted collisions first" : "";
  for (const btn of [document.getElementById("save-next-btn"), document.getElementById("save-back-btn")]) {
    btn.disabled = anyCollision;
    btn.title = title;
  }
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

function updateWidthUnitVisibility() {
  const anyWidth = [...document.querySelectorAll("select[data-column]")].some((s) => s.value === "source_width");
  document.getElementById("width-unit-row").classList.toggle("hidden", !anyWidth);
}

async function save(destination) {
  const assignments = {};
  for (const select of document.querySelectorAll("select[data-column]")) {
    assignments[select.dataset.column] = select.value || null;
  }
  const widthUnit = document.getElementById("width-unit").value.trim();

  const res = await fetch(`/api/column_map/${encodeURIComponent(sourceId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignments, width_unit: widthUnit }),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("save-status").textContent = data.error || "Failed to save";
    return;
  }

  if (destination === "back") {
    location.href = "index.html";
    return;
  }

  const nextSourceId = await findNextSource();
  location.href = nextSourceId ? `map.html?id=${encodeURIComponent(nextSourceId)}` : "index.html";
}

async function findNextSource() {
  const res = await fetch("/api/sources");
  const sources = await res.json();
  const next = sources.find(
    (s) => s.source_id !== sourceId && s.has_data && s.has_metadata && s.column_map_status !== "complete"
  );
  return next ? next.source_id : null;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

document.getElementById("save-next-btn").addEventListener("click", () => save("next"));
document.getElementById("save-back-btn").addEventListener("click", () => save("back"));
load();
