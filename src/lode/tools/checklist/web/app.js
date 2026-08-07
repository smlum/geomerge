let rows = [];
let sourcesDir = "";
let requiredFields = [];
let formatOptions = [];

async function loadMeta() {
  const res = await fetch("/api/meta");
  const meta = await res.json();
  document.getElementById("checklist-path").textContent = meta.checklist_path;
  sourcesDir = meta.sources_dir;
  requiredFields = meta.required_fields;
  formatOptions = meta.format_options;
}

async function loadRows() {
  const res = await fetch("/api/rows");
  rows = await res.json();
  render();
}

function isDone(row) {
  // A judgment call was made this run — not just that data (e.g. a prior-vintage
  // lead, already-scaffolded source_ids) happens to be sitting in the row.
  return Boolean(row.checked_date) || Boolean(row.checked);
}

function progressText(filterMode) {
  if (filterMode === "metadata_incomplete" || filterMode === "metadata_complete") {
    const sourcesTotal = rows.filter((r) => r.metadata_status !== "none").length;
    const completeCount = rows.filter((r) => r.metadata_status === "complete").length;
    return `${completeCount} / ${sourcesTotal} sources with metadata complete`;
  }
  const doneCount = rows.filter(isDone).length;
  return `${doneCount} / ${rows.length} checked`;
}

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  const body = document.getElementById("rows-body");
  body.innerHTML = "";

  let visible = rows;
  if (filterMode === "unchecked") {
    visible = rows.filter((r) => !isDone(r));
  } else if (filterMode === "metadata_incomplete") {
    visible = rows.filter((r) => r.metadata_status === "missing" || r.metadata_status === "partial");
  } else if (filterMode === "metadata_complete") {
    visible = rows.filter((r) => r.metadata_status === "complete");
  }

  document.getElementById("progress").textContent = progressText(filterMode);

  for (const row of visible) {
    body.appendChild(renderRow(row));
  }
}

function rowClass(row) {
  if (!isDone(row)) return "";
  if (!row.source_url) return "done not-found-row";
  return row.metadata_status === "complete" ? "done" : "done pending-metadata";
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.className = rowClass(row);

  const nameTd = document.createElement("td");
  nameTd.innerHTML = `<div class="name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</div><div class="meta">${row.province} · ${row.geography_level}</div>`;
  tr.appendChild(nameTd);

  const portalTd = document.createElement("td");
  if (row.portal_url) {
    portalTd.innerHTML = `<a class="portal-link" href="${escapeHtml(row.portal_url)}" target="_blank" rel="noopener">${escapeHtml(truncateUrl(row.portal_url, 24))}</a>`;
  } else {
    portalTd.innerHTML = `<span class="meta">no portal known</span>`;
  }
  tr.appendChild(portalTd);

  const actionsTd = document.createElement("td");
  actionsTd.className = "actions-cell";
  const foundBtn = document.createElement("button");
  foundBtn.className = "found" + (isDone(row) && row.source_url ? " confirmed" : "");
  foundBtn.textContent = "Found";
  foundBtn.onclick = () => submitFound(row);
  actionsTd.appendChild(foundBtn);

  const notFoundBtn = document.createElement("button");
  notFoundBtn.className = "not-found" + (isDone(row) && !row.source_url ? " confirmed" : "");
  notFoundBtn.textContent = "Not found";
  notFoundBtn.onclick = () => submitNotFound(row);
  actionsTd.appendChild(notFoundBtn);

  const errorDiv = document.createElement("div");
  errorDiv.className = "error";
  errorDiv.id = `error-${row.row_index}`;
  actionsTd.appendChild(errorDiv);
  tr.appendChild(actionsTd);

  const urlTd = document.createElement("td");
  const confirmedNotFound = isDone(row) && !row.source_url;
  // prior_url is permanent reference data (e.g. a 2024 CCND lead) — still
  // offered here regardless of checked state, including after a "Not found",
  // so it's never just gone if that judgment gets reconsidered.
  const displayUrl = row.source_url || row.prior_url || "";

  const urlWrapper = document.createElement("div");
  urlWrapper.className = "url-cell";

  if (confirmedNotFound && !displayUrl) {
    urlWrapper.innerHTML = `<span class="meta">marked not found</span>`;
  } else {
    if (displayUrl) {
      const openLink = document.createElement("a");
      openLink.className = "open-link";
      openLink.href = displayUrl;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.textContent = "Open";
      urlWrapper.appendChild(openLink);
    }
    if (confirmedNotFound) {
      urlWrapper.appendChild(Object.assign(document.createElement("span"), {
        className: "meta",
        textContent: "marked not found",
      }));
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "paste dataset URL";
      input.id = `input-${row.row_index}`;
      input.value = displayUrl;
      urlWrapper.appendChild(input);
    }
  }
  urlTd.appendChild(urlWrapper);
  tr.appendChild(urlTd);

  const metaTd = document.createElement("td");
  if (row.metadata_status === "none") {
    metaTd.innerHTML = `<span class="meta">—</span>`;
  } else {
    if (row.metadata_status !== "missing") {
      const badge = document.createElement("span");
      badge.className = `status status-${row.metadata_status}`;
      badge.textContent = row.metadata_status;
      metaTd.appendChild(badge);
    }

    const btn = document.createElement("button");
    btn.className = "metadata-btn";
    btn.textContent = row.metadata_status === "missing" ? "Add metadata" : "Edit";
    btn.onclick = () => openMetadata(row);
    metaTd.appendChild(btn);
  }
  tr.appendChild(metaTd);

  const notesTd = document.createElement("td");
  const notesInput = document.createElement("input");
  notesInput.type = "text";
  notesInput.className = "notes-input";
  notesInput.placeholder = "notes";
  notesInput.value = row.notes || "";
  notesInput.addEventListener("change", () => saveNote(row.row_index, notesInput.value));
  notesTd.appendChild(notesInput);
  tr.appendChild(notesTd);

  return tr;
}

async function saveNote(rowIndex, notes) {
  const res = await postJson("/api/note", { row_index: rowIndex, notes });
  if (res.ok) {
    const row = rows.find((r) => r.row_index === rowIndex);
    if (row) row.notes = notes;
  }
}

async function submitFound(row) {
  const input = document.getElementById(`input-${row.row_index}`);
  const errorDiv = document.getElementById(`error-${row.row_index}`);
  errorDiv.textContent = "";

  // Rows already confirmed "not found" don't render an input box (nothing to
  // edit) — fall back to a prompt if someone reconsiders and finds something.
  const sourceUrl = (input ? input.value : prompt("Paste dataset URL:", row.prior_url || "") || "").trim();

  if (!sourceUrl) {
    errorDiv.textContent = "Paste a URL first.";
    return;
  }

  const res = await postJson("/api/found", { row_index: row.row_index, source_url: sourceUrl });
  if (!res.ok) {
    errorDiv.textContent = res.error || "Failed";
    return;
  }
  await loadRows();
}

async function submitNotFound(row) {
  const input = document.getElementById(`input-${row.row_index}`);
  const notes = input.value.trim();
  const res = await postJson("/api/not_found", { row_index: row.row_index, notes });
  if (!res.ok) {
    document.getElementById(`error-${row.row_index}`).textContent = res.error || "Failed";
    return;
  }
  await loadRows();
}

const CURRENT_YEAR = new Date().getFullYear();
const EARLIEST_YEAR = 2000;

const METADATA_FIELDS = [
  { key: "dataset_page_url", url: true },
  { key: "download_url", url: true },
  { key: "raw_filename", detect: true },
  { key: "format", type: "select" },
  { key: "license_name" },
  { key: "license_url", url: true },
  { key: "contact" },
  { key: "source_updated_date", type: "year" },
  { key: "retrieved_date" },
  { key: "data_dictionary_url", url: true, sameAs: "dataset_page_url" },
  { key: "notes" },
];

let modalSourceId = null;
let fieldValidators = {};

async function openMetadata(row) {
  let sourceId = row.source_ids;
  if (row.metadata_status === "missing") {
    const res = await postJson("/api/generate", { row_index: row.row_index });
    if (!res.ok) {
      document.getElementById(`error-${row.row_index}`).textContent = res.error || "Failed to generate";
      return;
    }
    sourceId = res.source_id;
    await loadRows();
  }
  openModal(sourceId, row.notes);
}

async function openModal(sourceId, checklistNotes) {
  modalSourceId = sourceId;
  document.getElementById("modal-title").textContent = sourceId;
  document.getElementById("modal-path").textContent = `${sourcesDir}/${sourceId}/metadata.yaml`;
  document.getElementById("modal-save-status").textContent = "";

  const res = await fetch(`/api/source/${encodeURIComponent(sourceId)}`);
  const data = await res.json();
  // The checklist's own notes column is the source of truth for notes — it
  // propagates in here (and gets saved back into the yaml), not the other
  // way around.
  data.notes = checklistNotes || data.notes || "";

  const form = document.getElementById("metadata-form");
  form.innerHTML = "";
  fieldValidators = {};
  for (const field of METADATA_FIELDS) {
    const required = requiredFields.includes(field.key);

    const label = document.createElement("label");
    label.textContent = field.key + (required ? " *" : "");

    const row = document.createElement("div");
    row.className = "field-row";

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const opt of formatOptions) {
        const optionEl = document.createElement("option");
        optionEl.value = opt;
        optionEl.textContent = opt;
        input.appendChild(optionEl);
      }
      input.value = data[field.key] || formatOptions[0] || "";
    } else if (field.type === "year") {
      input = document.createElement("select");
      const blankOption = document.createElement("option");
      blankOption.value = "";
      blankOption.textContent = "(unknown)";
      input.appendChild(blankOption);
      for (let year = CURRENT_YEAR; year >= EARLIEST_YEAR; year--) {
        const optionEl = document.createElement("option");
        optionEl.value = String(year);
        optionEl.textContent = String(year);
        input.appendChild(optionEl);
      }
      // Existing values may be a full date from before this became a year picker.
      input.value = (data[field.key] || "").slice(0, 4);
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = data[field.key] || "";
    }
    input.id = `modal-field-${field.key}`;

    const markRequired = () => {
      if (required) input.classList.toggle("required-empty", !input.value);
    };
    markRequired();
    fieldValidators[field.key] = markRequired;
    input.addEventListener("input", markRequired);
    input.addEventListener("change", markRequired);

    row.appendChild(input);

    if (field.url) {
      const openLink = document.createElement("a");
      openLink.className = "open-link" + (input.value ? "" : " disabled");
      openLink.textContent = "Open";
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.href = input.value || "#";
      input.addEventListener("input", () => {
        openLink.href = input.value || "#";
        openLink.classList.toggle("disabled", !input.value);
      });
      row.appendChild(openLink);
    }

    if (field.detect) {
      const detectBtn = document.createElement("button");
      detectBtn.type = "button";
      detectBtn.className = "detect-btn";
      detectBtn.textContent = "Detect";
      detectBtn.onclick = detectRaw;
      row.appendChild(detectBtn);
    }

    if (field.sameAs) {
      const sameAsBtn = document.createElement("button");
      sameAsBtn.type = "button";
      sameAsBtn.className = "detect-btn";
      sameAsBtn.textContent = "Same as source";
      sameAsBtn.onclick = () => {
        input.value = document.getElementById(`modal-field-${field.sameAs}`).value;
        input.dispatchEvent(new Event("input"));
      };
      row.appendChild(sameAsBtn);
    }

    label.appendChild(row);
    form.appendChild(label);
  }

  document.getElementById("metadata-modal").classList.remove("hidden");
}

async function detectRaw() {
  const statusEl = document.getElementById("modal-save-status");
  const res = await fetch(`/api/detect_raw/${encodeURIComponent(modalSourceId)}`);
  const data = await res.json();
  if (!res.ok) {
    statusEl.textContent = data.error || "No file found";
    return;
  }

  const filenameInput = document.getElementById("modal-field-raw_filename");
  filenameInput.value = data.raw_filename;
  fieldValidators.raw_filename?.();

  if (data.format) {
    const formatInput = document.getElementById("modal-field-format");
    formatInput.value = data.format;
    fieldValidators.format?.();
  }

  statusEl.textContent = `Detected: ${data.raw_filename}`;
}

function closeModal() {
  document.getElementById("metadata-modal").classList.add("hidden");
  modalSourceId = null;
}

async function saveModal() {
  const updates = {};
  for (const field of METADATA_FIELDS) {
    updates[field.key] = document.getElementById(`modal-field-${field.key}`).value;
  }
  const res = await postJson(`/api/source/${encodeURIComponent(modalSourceId)}`, updates);
  if (!res.ok) {
    document.getElementById("modal-save-status").textContent = "Failed to save";
    return;
  }
  await loadRows();
  closeModal();
}

document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("metadata-modal").addEventListener("click", (e) => {
  if (e.target.id === "metadata-modal") closeModal();
});
document.getElementById("modal-save").addEventListener("click", (e) => {
  e.preventDefault();
  saveModal();
});

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error };
  return { ok: true, ...data };
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function truncateUrl(url, maxLen = 40) {
  const stripped = url.replace(/^https?:\/\//, "");
  return stripped.length <= maxLen ? stripped : stripped.slice(0, maxLen - 1) + "…";
}

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("checklist-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;

filterSelect.addEventListener("change", () => {
  localStorage.setItem("checklist-filter-mode", filterSelect.value);
  render();
});

loadMeta();
loadRows();
