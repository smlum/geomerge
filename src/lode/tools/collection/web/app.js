let rows = [];
let sourcesDir = "";
let requiredFields = [];
let formatOptions = [];
let geographyLevelOptions = [];
let providerFieldDescriptions = {};

async function loadMeta() {
  const res = await fetch("api/meta");
  const meta = await res.json();
  document.getElementById("checklist-path").textContent = `editing: ${meta.checklist_path}`;
  sourcesDir = meta.sources_dir;
  requiredFields = meta.required_fields;
  formatOptions = meta.format_options;
  geographyLevelOptions = meta.geography_level_options;
  providerFieldDescriptions = meta.provider_field_descriptions;
}

async function loadRows() {
  const res = await fetch("api/rows");
  rows = await res.json();
  render();
}

function isDone(row) {
  // A judgment call was made this run — not just that data (e.g. a prior-vintage
  // lead, already-scaffolded source_ids) happens to be sitting in the row.
  return Boolean(row.checked_date) || Boolean(row.checked);
}

// Reviewed and confirmed no usable source exists — distinct from a row
// that just hasn't been looked at yet (that one's neither found nor
// "not found", it's still pending).
function isNotFound(row) {
  return isDone(row) && !row.source_url;
}

function isMetadataComplete(row) {
  return row.metadata_status === "complete";
}

// "Complete" means nothing left to do at all — metadata fields filled in AND
// the raw file actually downloaded, not just one or the other.
function isComplete(row) {
  return isMetadataComplete(row) && row.raw_data_status === "complete";
}

function progressText(filterMode) {
  if (filterMode === "metadata_incomplete" || filterMode === "metadata_complete") {
    const sourcesTotal = rows.filter((r) => r.metadata_status !== "none").length;
    const completeCount = rows.filter(isComplete).length;
    return `${completeCount} / ${sourcesTotal} sources complete`;
  }
  const doneCount = rows.filter(isDone).length;
  const foundCount = rows.filter((r) => r.source_url).length;
  return `${doneCount} / ${rows.length} checked  ·  <span class="found-count">${foundCount} found</span>`;
}

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  const body = document.getElementById("rows-body");
  body.innerHTML = "";

  // Not found / Incomplete / Complete partition "All" exhaustively — every
  // row is exactly one of the three, so Incomplete is everything that
  // isn't already decided one way or the other, not just "has some
  // metadata but not all of it."
  let visible = rows;
  if (filterMode === "not_found") {
    visible = rows.filter(isNotFound);
  } else if (filterMode === "metadata_incomplete") {
    visible = rows.filter((r) => !isNotFound(r) && !isComplete(r));
  } else if (filterMode === "metadata_complete") {
    visible = rows.filter(isComplete);
  } else if (filterMode === "flagged") {
    // Cuts across the other three — a flagged row can be in any state,
    // this is just "needs my attention" regardless of where it stands.
    visible = rows.filter((r) => r.flagged);
  }

  document.getElementById("progress").innerHTML = progressText(filterMode);

  for (const row of visible) {
    body.appendChild(renderRow(row));
  }
}

function rowClass(row) {
  const flagClass = row.flagged ? " flagged-row" : "";
  if (!isDone(row)) return "" + flagClass;
  if (!row.source_url) return "done not-found-row" + flagClass;
  return (row.metadata_status === "complete" ? "done" : "done pending-metadata") + flagClass;
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.className = rowClass(row);

  const nameTd = document.createElement("td");
  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "name-link";
  nameBtn.title = `${row.name} — click to edit`;
  nameBtn.textContent = row.name;
  nameBtn.onclick = () => openAddSourceModal(row);
  nameTd.appendChild(nameBtn);
  const nameMeta = document.createElement("div");
  nameMeta.className = "meta";
  nameMeta.textContent = `${row.province} · ${row.geography_level}`;
  nameTd.appendChild(nameMeta);
  tr.appendChild(nameTd);

  // Editable, not just a link — providers.csv's snapshot of a portal URL
  // sometimes turns out to be wrong or stale, so this needs to be fixable
  // right here rather than requiring an edit somewhere else entirely.
  const portalTd = document.createElement("td");
  const portalWrapper = document.createElement("div");
  portalWrapper.className = "url-cell";

  const portalOpenLink = document.createElement("a");
  portalOpenLink.className = "open-link" + (row.portal_url ? "" : " disabled");
  portalOpenLink.href = row.portal_url || "#";
  portalOpenLink.target = "_blank";
  portalOpenLink.rel = "noopener";
  portalOpenLink.textContent = "Open";
  portalWrapper.appendChild(portalOpenLink);

  const portalInput = document.createElement("input");
  portalInput.type = "text";
  portalInput.placeholder = "portal URL";
  portalInput.value = row.portal_url || "";
  portalInput.addEventListener("input", () => {
    portalOpenLink.href = portalInput.value || "#";
    portalOpenLink.classList.toggle("disabled", !portalInput.value);
  });
  portalInput.addEventListener("change", () => savePortalUrl(row.row_index, portalInput.value.trim()));
  portalWrapper.appendChild(portalInput);

  portalTd.appendChild(portalWrapper);
  tr.appendChild(portalTd);

  const actionsTd = document.createElement("td");
  actionsTd.className = "actions-cell";
  const foundBtn = document.createElement("button");
  foundBtn.className = "found" + (isDone(row) && row.source_url ? " confirmed" : "");
  foundBtn.textContent = "Found";
  foundBtn.onclick = () => submitFound(row, foundBtn);
  actionsTd.appendChild(foundBtn);

  const notFoundBtn = document.createElement("button");
  notFoundBtn.className = "not-found" + (isDone(row) && !row.source_url ? " confirmed" : "");
  notFoundBtn.textContent = "Not found";
  notFoundBtn.onclick = () => submitNotFound(row, notFoundBtn);
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

  // Open always present, and always follows whatever's currently in the
  // input — not a fixed snapshot of displayUrl — same live-binding pattern
  // as the metadata modal's own url fields below.
  const openLink = document.createElement("a");
  openLink.className = "open-link" + (displayUrl ? "" : " disabled");
  openLink.href = displayUrl || "#";
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "Open";
  urlWrapper.appendChild(openLink);

  // Always editable, even once marked "not found" — that's exactly the case
  // where a prior lead (e.g. a CCND import) turned out to be dead and needs
  // replacing with the real URL, so the box can't just disappear on you.
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "paste dataset URL";
  input.id = `input-${row.row_index}`;
  input.value = displayUrl;
  input.addEventListener("input", () => {
    openLink.href = input.value || "#";
    openLink.classList.toggle("disabled", !input.value);
  });
  urlWrapper.appendChild(input);

  if (confirmedNotFound) {
    urlWrapper.appendChild(Object.assign(document.createElement("span"), {
      className: "meta",
      textContent: "not found",
    }));
  }

  urlTd.appendChild(urlWrapper);
  tr.appendChild(urlTd);

  // No action button here — the actual download stays a manual step (find
  // the file, drop it under data/raw/<source_id>/); this just flags whether
  // that's happened yet, same as the Metadata column's "none" convention for
  // rows not found yet.
  const rawTd = document.createElement("td");
  if (row.raw_data_status === "none") {
    rawTd.innerHTML = `<span class="meta">—</span>`;
  } else {
    const badge = document.createElement("span");
    badge.className = `status status-${row.raw_data_status}`;
    badge.textContent = row.raw_data_status;
    rawTd.appendChild(badge);
  }
  tr.appendChild(rawTd);

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

  // Flag is just "does this need my attention" — the note in the next
  // column over is where the actual reason/action lives (e.g. "email
  // their contact").
  const flagTd = document.createElement("td");
  flagTd.className = "flag-cell";
  const flagCheckbox = document.createElement("input");
  flagCheckbox.type = "checkbox";
  flagCheckbox.checked = Boolean(row.flagged);
  flagCheckbox.title = "Flag as needing action";
  flagCheckbox.addEventListener("change", () => toggleFlag(row, tr, flagCheckbox));
  flagTd.appendChild(flagCheckbox);
  tr.appendChild(flagTd);

  const notesTd = document.createElement("td");

  const notesInput = document.createElement("textarea");
  notesInput.rows = 1;
  notesInput.className = "notes-input";
  notesInput.placeholder = "notes";
  notesInput.value = row.notes || "";
  notesInput.addEventListener("focus", () => growNotes(notesInput));
  notesInput.addEventListener("input", () => growNotes(notesInput));
  notesInput.addEventListener("blur", () => {
    notesInput.classList.remove("expanded");
    notesInput.style.height = "";
  });
  notesInput.addEventListener("change", () => saveNote(row.row_index, notesInput.value));
  notesTd.appendChild(notesInput);
  tr.appendChild(notesTd);

  return tr;
}

function growNotes(el) {
  el.classList.add("expanded");
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

async function saveNote(rowIndex, notes) {
  const res = await postJson("api/note", { row_index: rowIndex, notes });
  if (res.ok) {
    const row = rows.find((r) => r.row_index === rowIndex);
    if (row) row.notes = notes;
  }
}

async function savePortalUrl(rowIndex, portalUrl) {
  const res = await postJson("api/portal_url", { row_index: rowIndex, portal_url: portalUrl });
  if (res.ok) {
    const row = rows.find((r) => r.row_index === rowIndex);
    if (row) row.portal_url = portalUrl;
  }
}

async function toggleFlag(row, tr, checkbox) {
  const flagged = checkbox.checked;
  const res = await postJson("api/flag", { row_index: row.row_index, flagged });
  if (!res.ok) {
    checkbox.checked = !flagged;
    return;
  }
  row.flagged = flagged ? "x" : "";
  tr.classList.toggle("flagged-row", flagged);
}

// Both flash the button's "confirmed" look before reloading — the reload
// often drops the row out of view entirely (e.g. the default "Unchecked"
// filter no longer matches it), so without a flash first, a successful
// click and a no-op would look identical.
async function submitFound(row, btn) {
  const input = document.getElementById(`input-${row.row_index}`);
  const errorDiv = document.getElementById(`error-${row.row_index}`);
  errorDiv.textContent = "";

  const sourceUrl = input.value.trim();

  if (!sourceUrl) {
    errorDiv.textContent = "Paste a URL first.";
    return;
  }

  const res = await postJson("api/found", { row_index: row.row_index, source_url: sourceUrl });
  if (!res.ok) {
    errorDiv.textContent = res.error || "Failed";
    return;
  }
  // Color flip is the confirmation, not a text change — appending a
  // checkmark made the button grow and get clipped in this narrow column.
  btn.classList.add("confirmed");
  setTimeout(loadRows, 700);
}

async function submitNotFound(row, btn) {
  const input = document.getElementById(`input-${row.row_index}`);
  const notes = input.value.trim();
  const res = await postJson("api/not_found", { row_index: row.row_index, notes });
  if (!res.ok) {
    document.getElementById(`error-${row.row_index}`).textContent = res.error || "Failed";
    return;
  }
  btn.classList.add("confirmed");
  setTimeout(loadRows, 700);
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

// A provider can have more than one relevant dataset (e.g. bike lanes and a
// separate multi-use-trails layer) — the modal shows one independent block
// per source, all fields visible immediately (no separate "create" step),
// plus a "+ Add another source" button that appends one more blank block.
// Numbering ("Source 1"/"Source 2") and the per-block Remove button only
// show once there's more than one — with just one, neither means anything.
let modalRowIndex = null;
let modalProviderId = null;
let modalChecklistNotes = "";
let modalNewSourceDefaults = {};
let modalBlocks = []; // { uid, sourceId, block, heading, pathLine, removeBtn, labelInput }
let blockUidCounter = 0;
let fieldValidators = {}; // fieldValidators[uid][fieldKey] = markRequired fn

// What generate() will actually prefill a brand-new source with — mirrored
// here so a not-yet-created block shows the same defaults immediately,
// rather than appearing blank until Save.
function newSourceDefaults(row) {
  return {
    dataset_page_url: row.source_url || "",
    license_name: row.portal_license_name || "",
    license_url: row.portal_license_url || "",
    open_license: null, // never reviewed yet — must be null, not undefined, to match generate()'s default and keep the auto-follow-as-you-type checkbox behavior working
    contact: row.contact || "",
    retrieved_date: new Date().toISOString().slice(0, 10),
  };
}

async function openMetadata(row) {
  modalRowIndex = row.row_index;
  modalProviderId = row.provider_id;
  modalChecklistNotes = row.notes || "";
  modalNewSourceDefaults = newSourceDefaults(row);
  fieldValidators = {};
  modalBlocks = [];

  document.getElementById("modal-title").textContent = row.name;
  document.getElementById("modal-save-status").textContent = "";

  const container = document.getElementById("metadata-blocks");
  container.innerHTML = "";

  const existingIds = (row.source_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (existingIds.length === 0) {
    addSourceBlock(null, { ...modalNewSourceDefaults });
  } else {
    for (const sourceId of existingIds) {
      const res = await fetch(`api/source/${encodeURIComponent(sourceId)}`);
      const data = await res.json();
      addSourceBlock(sourceId, data);
    }
  }
  refreshBlockChrome();

  document.getElementById("metadata-modal").classList.remove("hidden");
}

function refreshBlockChrome() {
  const multi = modalBlocks.length > 1;
  modalBlocks.forEach((b, i) => {
    b.heading.textContent = `Source ${i + 1}`;
    b.heading.classList.toggle("hidden", !multi);
    b.removeBtn.classList.toggle("hidden", !multi);
  });
}

function addSourceBlock(sourceId, data) {
  const uid = blockUidCounter++;
  const container = document.getElementById("metadata-blocks");
  const block = document.createElement("div");
  block.className = "source-block";

  const blockHeader = document.createElement("div");
  blockHeader.className = "source-block-header";
  const heading = document.createElement("h3");
  heading.className = "hidden";
  blockHeader.appendChild(heading);
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-source-btn hidden";
  removeBtn.textContent = "Remove";
  blockHeader.appendChild(removeBtn);
  block.appendChild(blockHeader);

  const pathLine = document.createElement("div");
  pathLine.className = "meta source-path";
  block.appendChild(pathLine);

  const blockState = { uid, sourceId, block, heading, pathLine, removeBtn, labelInput: null };
  modalBlocks.push(blockState);
  removeBtn.onclick = () => removeSourceBlock(blockState);

  function updatePathPreview() {
    if (blockState.sourceId) return; // locked once real — this stays static
    const isFirst = modalBlocks[0] === blockState;
    const label = blockState.labelInput.value.trim();
    if (label) {
      pathLine.textContent = `editing: ${sourcesDir}/${modalProviderId}_${slugify(label)}/metadata.yaml`;
    } else if (isFirst) {
      pathLine.textContent = `editing: ${sourcesDir}/${modalProviderId}_cycling/metadata.yaml`;
    } else {
      pathLine.textContent = "editing: (enter a label first)";
    }
  }

  if (sourceId) {
    pathLine.textContent = `editing: ${sourcesDir}/${sourceId}/metadata.yaml`;
  }
  // Uncommitted blocks get their initial preview set once labelInput exists,
  // right after it's created below — updatePathPreview() reads its value.

  // The checklist's own notes column is the source of truth for notes — it
  // propagates in here (and gets saved back into the yaml), not the other
  // way around.
  data.notes = modalChecklistNotes || data.notes || "";

  const form = document.createElement("form");
  form.className = "edit-form";
  fieldValidators[uid] = {};

  for (const field of METADATA_FIELDS) {
    // label lives right before raw_filename — optional for a provider's
    // first source (still useful, e.g. "multi_use_trails"), required for
    // any source after that (there has to be some way to tell them apart).
    // Baked into source_id once created, so it's locked from then on.
    if (field.key === "raw_filename") {
      const isFirst = modalBlocks[0] === blockState;
      const labelRequired = !sourceId && !isFirst;

      const labelLabelEl = document.createElement("label");
      labelLabelEl.textContent = "label" + (labelRequired ? " *" : "");
      labelLabelEl.title = "Baked into this source's id once created — can't be changed afterward.";

      const labelRow = document.createElement("div");
      labelRow.className = "field-row";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.placeholder = isFirst ? "optional, e.g. multi_use_trails" : "required, e.g. multi_use_trails";
      labelInput.value = data.label || "";
      labelInput.disabled = Boolean(sourceId);
      labelInput.id = `modal-field-${uid}-label`;

      const markLabelRequired = () => {
        if (labelRequired) labelInput.classList.toggle("required-empty", !labelInput.value);
      };
      markLabelRequired();
      fieldValidators[uid].label = markLabelRequired;
      if (!sourceId) {
        labelInput.addEventListener("input", () => {
          markLabelRequired();
          updatePathPreview();
        });
      }

      labelRow.appendChild(labelInput);

      // Locked by default (baked into source_id already) — but early on,
      // before anything downstream depends on that exact id, a rename is
      // still safe. Two clicks: first unlocks the field to edit, second
      // actually renames the folder/yaml/checklist entry on disk.
      if (sourceId) {
        if (data._can_rename) {
          const renameBtn = document.createElement("button");
          renameBtn.type = "button";
          renameBtn.className = "detect-btn";
          renameBtn.textContent = "Rename";
          renameBtn.onclick = async () => {
            if (labelInput.disabled) {
              labelInput.disabled = false;
              labelInput.focus();
              renameBtn.textContent = "Confirm rename";
              return;
            }
            const newLabel = labelInput.value.trim();
            const ok = confirm(
              `Rename this source's id to match "${newLabel || "(default)"}"? This moves its folder on disk.`
            );
            if (!ok) return;
            const res = await postJson("api/rename_source", {
              row_index: modalRowIndex,
              old_source_id: blockState.sourceId,
              label: newLabel,
            });
            const statusEl = document.getElementById("modal-save-status");
            if (!res.ok) {
              statusEl.textContent = res.error || "Failed to rename";
              return;
            }
            blockState.sourceId = res.source_id;
            pathLine.textContent = `editing: ${sourcesDir}/${res.source_id}/metadata.yaml`;
            labelInput.disabled = true;
            renameBtn.textContent = "Rename";
            await loadRows();
          };
          labelRow.appendChild(renameBtn);
        } else {
          labelInput.title = "Can't rename — later pipeline steps already reference this source.";
        }
      }

      labelLabelEl.appendChild(labelRow);
      form.appendChild(labelLabelEl);
      blockState.labelInput = labelInput;
      if (!sourceId) updatePathPreview();
    }

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
    input.id = `modal-field-${uid}-${field.key}`;

    const markRequired = () => {
      if (required) input.classList.toggle("required-empty", !input.value);
    };
    markRequired();
    fieldValidators[uid][field.key] = markRequired;
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
      detectBtn.onclick = () => detectRaw(blockState);
      row.appendChild(detectBtn);
    }

    if (field.sameAs) {
      const sameAsBtn = document.createElement("button");
      sameAsBtn.type = "button";
      sameAsBtn.className = "detect-btn";
      sameAsBtn.textContent = "Same as source";
      sameAsBtn.onclick = () => {
        input.value = document.getElementById(`modal-field-${uid}-${field.sameAs}`).value;
        input.dispatchEvent(new Event("input"));
      };
      row.appendChild(sameAsBtn);
    }

    // Lives on license_url's row rather than as its own field — it's the
    // one binary fact that matters most for any data release, so it stays
    // right next to the license itself instead of scrolling past it.
    if (field.key === "license_url") {
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "inline-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `modal-field-${uid}-open_license`;
      // Respect an explicit saved value either way; only auto-follow the
      // URL field (live, as it's typed) when it's never been reviewed —
      // and stop following the moment the user touches the checkbox
      // themselves, so a manual choice never gets silently overwritten.
      let openLicenseTouched = data.open_license !== null;
      checkbox.checked = data.open_license === true || (!openLicenseTouched && Boolean(input.value));
      checkbox.addEventListener("change", () => {
        openLicenseTouched = true;
      });
      input.addEventListener("input", () => {
        if (!openLicenseTouched) checkbox.checked = Boolean(input.value);
      });
      checkboxLabel.appendChild(checkbox);
      checkboxLabel.append(" Open license");
      row.appendChild(checkboxLabel);
    }

    label.appendChild(row);
    form.appendChild(label);
  }

  block.appendChild(form);
  container.appendChild(block);
}

async function removeSourceBlock(blockState) {
  const statusEl = document.getElementById("modal-save-status");
  if (blockState.sourceId) {
    const ok = confirm(
      `Remove ${blockState.sourceId}? This permanently deletes its metadata.yaml and any downloaded raw data.`
    );
    if (!ok) return;
    const res = await postJson("api/remove_source", { row_index: modalRowIndex, source_id: blockState.sourceId });
    if (!res.ok) {
      statusEl.textContent = res.error || "Failed to remove";
      return;
    }
  }
  blockState.block.remove();
  modalBlocks = modalBlocks.filter((b) => b !== blockState);
  refreshBlockChrome();
  if (blockState.sourceId) await loadRows();
}

async function detectRaw(blockState) {
  const statusEl = document.getElementById("modal-save-status");

  // Not saved yet, but its raw folder may already exist: "Found" pre-creates
  // data/raw/<provider_id>_cycling/ for a provider's first source the moment
  // a source_url is set, well before its metadata.yaml is ever generated —
  // so this mirrors that same (label-or-default) id, same as updatePathPreview,
  // rather than requiring a save first just to look inside an existing folder.
  let sourceId = blockState.sourceId;
  if (!sourceId) {
    const isFirst = modalBlocks[0] === blockState;
    const label = blockState.labelInput.value.trim();
    if (label) {
      sourceId = `${modalProviderId}_${slugify(label)}`;
    } else if (isFirst) {
      sourceId = `${modalProviderId}_cycling`;
    } else {
      statusEl.textContent = "Enter a label first so this source's folder can be identified.";
      return;
    }
  }
  const res = await fetch(`api/detect_raw/${encodeURIComponent(sourceId)}`);
  const data = await res.json();
  if (!res.ok) {
    statusEl.textContent = data.error || "No file found";
    return;
  }

  const filenameInput = document.getElementById(`modal-field-${blockState.uid}-raw_filename`);
  filenameInput.value = data.raw_filename;
  fieldValidators[blockState.uid]?.raw_filename?.();

  if (data.format) {
    const formatInput = document.getElementById(`modal-field-${blockState.uid}-format`);
    formatInput.value = data.format;
    fieldValidators[blockState.uid]?.format?.();
  }
}

function closeModal() {
  document.getElementById("metadata-modal").classList.add("hidden");
  modalRowIndex = null;
  modalProviderId = null;
  modalBlocks = [];
}

async function saveModal() {
  const statusEl = document.getElementById("modal-save-status");
  for (const blockState of modalBlocks) {
    if (!blockState.sourceId) {
      const label = blockState.labelInput.value.trim();
      const res = await postJson("api/generate", { row_index: modalRowIndex, label });
      if (!res.ok) {
        statusEl.textContent = res.error || "Failed to create source";
        return;
      }
      blockState.sourceId = res.source_id;
      blockState.pathLine.textContent = `editing: ${sourcesDir}/${res.source_id}/metadata.yaml`;
      blockState.labelInput.disabled = true;
    }

    const updates = {};
    for (const field of METADATA_FIELDS) {
      updates[field.key] = document.getElementById(`modal-field-${blockState.uid}-${field.key}`).value;
    }
    updates.open_license = document.getElementById(`modal-field-${blockState.uid}-open_license`).checked;
    const res = await postJson(`api/source/${encodeURIComponent(blockState.sourceId)}`, updates);
    if (!res.ok) {
      statusEl.textContent = `Failed to save ${blockState.sourceId}`;
      return;
    }
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
document.getElementById("add-another-source-btn").addEventListener("click", () => {
  addSourceBlock(null, { ...modalNewSourceDefaults });
  refreshBlockChrome();
});

// --- Add source modal ----------------------------------------------------
// Adds a new row straight to checklist.csv only — not providers.csv (the
// master registry these came from originally). Reconciling the two is a
// separate problem for later; this just unblocks tracking a source that
// isn't in the checklist yet.

// Matches the real provider_id convention already in checklist.csv (e.g.
// "City of Calgary" + AB -> ab_calgary): strip the generic civic prefix,
// slugify what's left, prefix with the lowercased province code.
const NAME_PREFIXES = [
  "regional municipality of", "district municipality of", "municipality of",
  "government of", "city of", "town of", "county of", "region of",
  "district of", "township of", "village of",
];

function stripNamePrefix(name) {
  const lower = name.toLowerCase();
  for (const prefix of NAME_PREFIXES) {
    if (lower.startsWith(prefix + " ")) return name.slice(prefix.length + 1);
  }
  return name;
}

const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(text) {
  return text
    .normalize("NFD").replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function generateProviderId(name, province) {
  const slug = slugify(stripNamePrefix(name));
  const code = province.toLowerCase().trim();
  return code ? `${code}_${slug}` : slug;
}

const PROVINCE_OPTIONS = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"],
  ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"], ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"], ["NU", "Nunavut"], ["ON", "Ontario"],
  ["PE", "Prince Edward Island"], ["QC", "Quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
];

// Name first (so there's something to generate an id from), then id itself
// with a Generate button next to it — still freely editable either way.
// geography_level/province are real dropdowns rather than free text so
// what's typed always matches what providers.csv actually accepts.
const ADD_SOURCE_FIELDS = [
  { key: "name", label: "name", required: true },
  { key: "province", label: "province", type: "select", options: () => PROVINCE_OPTIONS },
  { key: "provider_id", label: "provider_id", required: true, genId: true },
  { key: "geography_level", label: "geography_level", required: true, type: "select", options: () => geographyLevelOptions },
  { key: "portal_url", label: "portal_url" },
  { key: "portal_license_name", label: "portal_license_name" },
  { key: "portal_license_url", label: "portal_license_url" },
  { key: "contact", label: "contact" },
  { key: "notes", label: "notes" },
];

// editRow is undefined when adding, or an existing row (from `rows`) when
// editing that row in place — same form either way, just pre-filled, with
// provider_id locked (it's a stable key set only once, at creation) and
// posting to update_row instead of add_row.
let editingRowIndex = null;

function openAddSourceModal(editRow) {
  editingRowIndex = editRow ? editRow.row_index : null;
  document.getElementById("add-source-title").textContent = editRow ? "Edit provider" : "Add provider";
  document.getElementById("add-source-save").textContent = editRow ? "Save" : "Add";
  document.getElementById("add-source-error").classList.add("hidden");
  document.getElementById("add-source-save-status").textContent = "";

  const form = document.getElementById("add-source-form");
  form.innerHTML = "";
  const inputs = {};

  for (const field of ADD_SOURCE_FIELDS) {
    const label = document.createElement("label");
    label.textContent = field.label + (field.required ? " *" : "");
    const description = providerFieldDescriptions[field.key];
    if (description) label.title = description;

    const row = document.createElement("div");
    row.className = "field-row";

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— choose —";
      input.appendChild(blank);
      for (const opt of field.options()) {
        const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
        const optionEl = document.createElement("option");
        optionEl.value = value;
        optionEl.textContent = text;
        input.appendChild(optionEl);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.id = `add-source-field-${field.key}`;
    input.value = editRow ? (editRow[field.key] || "") : "";
    if (field.key === "provider_id" && editRow) {
      input.disabled = true;
      input.title = "provider_id is set once at creation and can't be changed here.";
    }
    inputs[field.key] = input;

    const markRequired = () => {
      if (field.required) input.classList.toggle("required-empty", !input.value);
    };
    markRequired();
    input.addEventListener("input", markRequired);
    input.addEventListener("change", markRequired);

    row.appendChild(input);

    if (field.genId && !editRow) {
      const genBtn = document.createElement("button");
      genBtn.type = "button";
      genBtn.className = "detect-btn";
      genBtn.textContent = "Generate";
      genBtn.title = "Fill in from name + province, e.g. \"City of Calgary\" + AB -> ab_calgary";
      genBtn.onclick = () => {
        const name = inputs.name.value.trim();
        if (!name) return;
        input.value = generateProviderId(name, inputs.province.value);
        input.dispatchEvent(new Event("input"));
        checkIdCollision(input);
      };
      row.appendChild(genBtn);
    }

    label.appendChild(row);

    if (field.genId && !editRow) {
      const warning = document.createElement("div");
      warning.className = "error hidden";
      warning.id = "add-source-id-warning";
      label.appendChild(warning);
      input.addEventListener("input", () => checkIdCollision(input));
    }

    form.appendChild(label);
  }

  document.getElementById("add-source-modal").classList.remove("hidden");
}

function checkIdCollision(idInput) {
  const warning = document.getElementById("add-source-id-warning");
  const id = idInput.value.trim();
  const exists = id && rows.some((r) => r.provider_id === id);
  warning.textContent = exists ? `"${id}" already exists in the checklist` : "";
  warning.classList.toggle("hidden", !exists);
}

function closeAddSourceModal() {
  document.getElementById("add-source-modal").classList.add("hidden");
}

async function saveAddSource() {
  const values = {};
  for (const field of ADD_SOURCE_FIELDS) {
    values[field.key] = document.getElementById(`add-source-field-${field.key}`).value.trim();
  }

  const editing = editingRowIndex !== null;
  if (editing) values.row_index = editingRowIndex;

  const errorEl = document.getElementById("add-source-error");
  const res = await postJson(editing ? "api/update_row" : "api/add_row", values);
  if (!res.ok) {
    errorEl.textContent = res.error || (editing ? "Failed to save" : "Failed to add source");
    errorEl.classList.remove("hidden");
    return;
  }
  await loadRows();
  closeAddSourceModal();
}

document.getElementById("add-source-btn").addEventListener("click", () => openAddSourceModal());
document.getElementById("add-source-close").addEventListener("click", closeAddSourceModal);
document.getElementById("add-source-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-source-modal") closeAddSourceModal();
});
document.getElementById("add-source-save").addEventListener("click", (e) => {
  e.preventDefault();
  saveAddSource();
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

const filterSelect = document.getElementById("filter-mode");
const savedFilter = localStorage.getItem("checklist-filter-mode");
if (savedFilter) filterSelect.value = savedFilter;

filterSelect.addEventListener("change", () => {
  localStorage.setItem("checklist-filter-mode", filterSelect.value);
  render();
});

// Deep link from lode tools home's Metadata column (?id=<source_id>) — jumps
// straight into that source's metadata modal instead of landing on the full
// checklist and making you go find the row yourself.
async function openFromQueryParam() {
  const sourceId = new URLSearchParams(location.search).get("id");
  if (!sourceId) return;
  const row = rows.find((r) => (r.source_ids || "").split(",").map((s) => s.trim()).includes(sourceId));
  if (row) await openMetadata(row);
}

// Table header sticks right below the page header, which itself sticks
// right below the nav bar — both measured rather than hardcoded, since
// their height can reflow on resize. Nav and header are static markup (no
// fetched content), so this runs immediately rather than waiting on
// bootstrap()'s fetches — table-scroll is correctly sized to fill the
// viewport from first paint instead of jumping once data arrives.
//
// Measured via table-scroll's own boundingClientRect (plus the current
// scroll offset, to get its true document position rather than wherever
// it's currently scrolled to), not by summing up nav/header offsetHeights
// — those miss the CSS margins between nav, header and table-scroll,
// which undercounts the real space consumed above it.
//
// The footer, unlike nav/header, sizes its own dynamically-loaded content
// (the progress stat), so it isn't safe to measure this early — instead
// it's given a fixed CSS height (see .lode-footer), which table-scroll's
// max-height subtracts as a plain constant. Fixed also means the footer
// never resizes once its text pops in, which was the actual "jumps on
// load" bug.
function updateHeaderOffset() {
  const nav = document.querySelector(".lode-nav");
  const tableScroll = document.querySelector(".table-scroll");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
  if (tableScroll) {
    const topOffset = tableScroll.getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty("--header-height", `${topOffset}px`);
  }
}
window.addEventListener("resize", updateHeaderOffset);
updateHeaderOffset();

async function bootstrap() {
  await loadMeta();
  await loadRows();
  await openFromQueryParam();
}

bootstrap();
