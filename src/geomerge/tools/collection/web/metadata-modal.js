// Source metadata modal — one block per source (metadata.yaml) for a
// checklist row, opened from the table's Metadata column, right after
// "Found", or via ?id=<source_id>. Loaded before app.js; uses its globals
// (rows, loadRows, postJson, slugify, …) only at call time.
//
// A new source starts as just its title (plus the dataset link): the id is
// suggested from the title, and nothing exists on disk until "Create
// source". Only then do the rest of the fields — and the drop zone that puts
// the downloaded file in the right raw folder — appear.

const CURRENT_YEAR = new Date().getFullYear();
const EARLIEST_YEAR = 2000;

const METADATA_FIELDS = [
  { key: "dataset_title" },
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

// Shown before the source exists; everything else waits for "Create source".
const PRE_CREATE_FIELDS = new Set(["dataset_title", "dataset_page_url"]);

// A provider can have more than one relevant dataset (e.g. bike lanes and a
// separate multi-use-trails layer) — the modal shows one independent block
// per source, plus a "+ Add another source" button that appends one more
// blank block. Numbering ("Source 1"/"Source 2") and the per-block Remove
// button only show once there's more than one.
let modalRowIndex = null;
let modalProviderId = null;
let modalNewSourceDefaults = {};
let modalBlocks = []; // { uid, sourceId, block, heading, pathLine, removeBtn, labelInput, titleInput, rest }
let blockUidCounter = 0;
let fieldValidators = {}; // fieldValidators[uid][fieldKey] = markRequired fn

// What generate() will actually prefill a brand-new source with — mirrored
// here so a not-yet-created block shows the same defaults immediately.
function newSourceDefaults(row) {
  return {
    dataset_page_url: row.source_url || "",
    license_name: row.portal_license_name || "",
    license_url: row.portal_license_url || "",
    open_license: null, // never reviewed yet — must be null, not undefined, to keep the auto-follow-as-you-type checkbox behavior working
    contact: row.contact || "",
    retrieved_date: new Date().toISOString().slice(0, 10),
  };
}

// Id suffix suggested from a dataset title: its slug, minus words the
// provider id already has ("Ontario Trail Network" for on_ontario ->
// trail_network), capped at a readable length on a word boundary.
function suffixFromTitle(title) {
  const providerWords = new Set(modalProviderId.split("_").slice(1));
  const words = slugify(title).split("_").filter(Boolean);
  const kept = words.filter((w) => !providerWords.has(w));
  let suffix = "";
  for (const w of kept.length ? kept : words) {
    const next = suffix ? `${suffix}_${w}` : w;
    if (suffix && next.length > 40) break;
    suffix = next;
  }
  return suffix;
}

async function openMetadata(row) {
  // Always the freshest copy — a row object captured before a create/rename
  // has stale source_ids, which used to spawn duplicate sources.
  row = rows.find((r) => r.row_index === row.row_index) || row;
  modalRowIndex = row.row_index;
  modalProviderId = row.provider_id;
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
  const firstNew = modalBlocks.find((b) => !b.sourceId);
  if (firstNew) firstNew.titleInput.focus();
}

function refreshBlockChrome() {
  const multi = modalBlocks.length > 1;
  modalBlocks.forEach((b, i) => {
    b.heading.textContent = `Source ${i + 1}`;
    b.heading.classList.toggle("hidden", !multi);
    b.removeBtn.classList.toggle("hidden", !multi);
  });
}

function setPathLine(blockState) {
  const id = blockState.sourceId || `${modalProviderId}_${blockState.labelInput.value.trim()}`;
  blockState.pathLine.textContent = `${blockState.sourceId ? "editing" : "will create"}: ${sourcesDir}/${id}/metadata.yaml`;
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

  const blockState = { uid, sourceId, block, heading, pathLine, removeBtn, labelInput: null, titleInput: null, rest: null };
  modalBlocks.push(blockState);
  removeBtn.onclick = () => removeSourceBlock(blockState);

  // The source's own note (metadata.yaml — shared by every stage, see
  // helpers/source_notes.py), not the checklist row's provider-level note.
  data.notes = data.notes || "";

  const form = document.createElement("form");
  form.className = "edit-form";
  const rest = document.createElement("div");
  rest.className = "edit-form" + (sourceId ? "" : " hidden");
  blockState.rest = rest;
  fieldValidators[uid] = {};

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
      detectBtn.title = "Use the newest file already in this source's raw folder";
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

    // Lives on license_url's row — the one binary fact that matters most for
    // any data release, so it stays right next to the license itself.
    if (field.key === "license_url") {
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "inline-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `modal-field-${uid}-open_license`;
      // Respect an explicit saved value either way; only auto-follow the URL
      // field when it's never been reviewed, and stop the moment the user
      // touches the checkbox themselves.
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
    (PRE_CREATE_FIELDS.has(field.key) ? form : rest).appendChild(label);

    if (field.key === "dataset_title") {
      blockState.titleInput = input;
      form.appendChild(buildIdRow(blockState, data));
    }
    if (field.key === "raw_filename") rest.appendChild(buildDropZone(blockState));
  }

  form.appendChild(rest);
  block.appendChild(form);
  container.appendChild(block);
  setPathLine(blockState);
}

// source id: provider prefix + an editable suffix. Before creation the
// suffix follows the title (until edited by hand) and "Create source" is the
// block's one action; afterwards it's locked, with Rename while nothing
// downstream depends on the id yet.
function buildIdRow(blockState, data) {
  const { sourceId, titleInput } = blockState;
  const statusEl = () => document.getElementById("modal-save-status");

  const wrapper = document.createElement("label");
  wrapper.textContent = "source id";
  const row = document.createElement("div");
  row.className = "field-row";
  const prefix = document.createElement("span");
  prefix.className = "id-prefix meta";
  prefix.textContent = `${modalProviderId}_`;
  row.appendChild(prefix);

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.id = `modal-field-${blockState.uid}-label`;
  labelInput.value = sourceId ? sourceId.slice(modalProviderId.length + 1) : suffixFromTitle(titleInput.value);
  labelInput.disabled = Boolean(sourceId);
  blockState.labelInput = labelInput;
  row.appendChild(labelInput);

  if (!sourceId) {
    let suffixEdited = false;
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "create-source-btn";
    createBtn.textContent = "Create source";
    const sync = () => {
      createBtn.disabled = !titleInput.value.trim() || !labelInput.value.trim();
      setPathLine(blockState);
    };
    titleInput.addEventListener("input", () => {
      if (!suffixEdited) labelInput.value = suffixFromTitle(titleInput.value);
      sync();
    });
    labelInput.addEventListener("input", () => {
      suffixEdited = true;
      sync();
    });
    // Enter in the title creates, rather than submitting the form.
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!createBtn.disabled) createBtn.click();
      }
    });
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      const ok = await createSource(blockState);
      if (!ok) {
        sync();
        return;
      }
      createBtn.remove();
      statusEl().textContent = `Created ${blockState.sourceId}.`;
    };
    sync();
    row.appendChild(createBtn);
  } else if (data._can_rename) {
    // Two clicks: first unlocks the field (suggesting the title's suffix if
    // the id is still a generic default), second renames on disk.
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "detect-btn";
    renameBtn.textContent = "Rename";
    renameBtn.onclick = async () => {
      if (labelInput.disabled) {
        labelInput.disabled = false;
        if (/^cycling(_\d+)?$/.test(labelInput.value) && titleInput.value.trim()) {
          labelInput.value = suffixFromTitle(titleInput.value);
        }
        labelInput.focus();
        renameBtn.textContent = "Confirm rename";
        return;
      }
      const newLabel = labelInput.value.trim();
      const ok = confirm(`Rename this source to ${modalProviderId}_${newLabel}? This moves its folders on disk.`);
      if (!ok) return;
      const res = await postJson("api/rename_source", {
        row_index: modalRowIndex,
        old_source_id: blockState.sourceId,
        label: newLabel,
      });
      if (!res.ok) {
        statusEl().textContent = res.error || "Failed to rename";
        return;
      }
      blockState.sourceId = res.source_id;
      setPathLine(blockState);
      labelInput.disabled = true;
      renameBtn.textContent = "Rename";
      await loadRows();
    };
    row.appendChild(renameBtn);
  } else {
    labelInput.title = "Can't rename — later pipeline steps already reference this source.";
  }

  wrapper.appendChild(row);
  return wrapper;
}

async function createSource(blockState) {
  const uid = blockState.uid;
  const res = await postJson("api/generate", {
    row_index: modalRowIndex,
    label: blockState.labelInput.value.trim(),
    dataset_title: blockState.titleInput.value.trim(),
    dataset_page_url: document.getElementById(`modal-field-${uid}-dataset_page_url`).value.trim(),
  });
  if (!res.ok) {
    document.getElementById("modal-save-status").textContent = res.error || "Failed to create source";
    return false;
  }
  blockState.sourceId = res.source_id;
  blockState.labelInput.value = res.source_id.slice(modalProviderId.length + 1);
  blockState.labelInput.disabled = true;
  blockState.rest.classList.remove("hidden");
  setPathLine(blockState);
  await loadRows();
  return true;
}

// Pick or drop the downloaded file: it's copied into this source's raw
// folder (a zip unpacked), and raw_filename/format/retrieved_date are filled.
function buildDropZone(blockState) {
  const zone = document.createElement("div");
  zone.className = "drop-zone";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const text = document.createElement("span");
  zone.append(fileInput, text);

  const filenameInput = () => document.getElementById(`modal-field-${blockState.uid}-raw_filename`);
  const refreshText = () => {
    text.textContent = filenameInput()?.value
      ? "Drop a newer download here, or click to choose"
      : "Drop the downloaded file here, or click to choose";
  };
  // raw_filename's input is created just before this zone.
  setTimeout(refreshText);

  zone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) uploadRaw(blockState, fileInput.files, zone, refreshText);
    fileInput.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) uploadRaw(blockState, e.dataTransfer.files, zone, refreshText);
  });
  return zone;
}

async function uploadRaw(blockState, files, zone, refreshText) {
  const statusEl = document.getElementById("modal-save-status");
  const form = new FormData();
  for (const f of files) form.append("files", f);
  zone.classList.add("uploading");
  statusEl.textContent = `Copying ${files.length === 1 ? files[0].name : `${files.length} files`}…`;
  let data;
  try {
    const res = await fetch(`api/source/${encodeURIComponent(blockState.sourceId)}/upload`, { method: "POST", body: form });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
  } catch (e) {
    statusEl.textContent = e.message;
    return;
  } finally {
    zone.classList.remove("uploading");
  }
  const uid = blockState.uid;
  for (const key of ["raw_filename", "format", "retrieved_date"]) {
    document.getElementById(`modal-field-${uid}-${key}`).value = data[key];
    fieldValidators[uid]?.[key]?.();
  }
  statusEl.textContent = `Added ${data.raw_filename} to ${blockState.sourceId}.`;
  refreshText();
  await loadRows();
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

// For a file put in data/raw/<source_id>/ some other way (e.g. a big download
// fetched from the command line) — only offered once the source exists.
async function detectRaw(blockState) {
  const statusEl = document.getElementById("modal-save-status");
  const res = await fetch(`api/detect_raw/${encodeURIComponent(blockState.sourceId)}`);
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
      // A block never given a title is just left uncreated.
      if (!blockState.titleInput.value.trim()) continue;
      if (!(await createSource(blockState))) return;
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
// A file dropped anywhere else in the modal shouldn't make the browser
// navigate away to open it.
for (const type of ["dragover", "drop"]) {
  document.getElementById("metadata-modal").addEventListener(type, (e) => e.preventDefault());
}
document.getElementById("modal-save").addEventListener("click", (e) => {
  e.preventDefault();
  saveModal();
});
document.getElementById("add-another-source-btn").addEventListener("click", () => {
  // Everything but the dataset link carries over (licence, contact…) —
  // the row's Data URL is the first source's, not this one's.
  addSourceBlock(null, { ...modalNewSourceDefaults, dataset_page_url: "" });
  refreshBlockChrome();
  modalBlocks[modalBlocks.length - 1].titleInput.focus();
});
