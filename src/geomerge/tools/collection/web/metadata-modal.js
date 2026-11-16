// Source metadata modal — one block per source (metadata.yaml) for a
// checklist row, opened from the table's Metadata column or ?id=<source_id>.
// Loaded before app.js; uses its globals (rows, loadRows, postJson, …) only
// at call time.

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

// A provider can have more than one relevant dataset (e.g. bike lanes and a
// separate multi-use-trails layer) — the modal shows one independent block
// per source, all fields visible immediately (no separate "create" step),
// plus a "+ Add another source" button that appends one more blank block.
// Numbering ("Source 1"/"Source 2") and the per-block Remove button only
// show once there's more than one — with just one, neither means anything.
let modalRowIndex = null;
let modalProviderId = null;
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

  // The source's own note (metadata.yaml — shared by every stage, see
  // helpers/source_notes.py), not the checklist row's provider-level note
  // in the table's Notes column. The two used to be copied into each other,
  // which overwrote per-source notes on providers with more than one source.
  data.notes = data.notes || "";

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

      // Not created yet: "Create folder" makes the source now (same as
      // Save would — metadata.yaml + its raw data folder, label locked),
      // without closing the modal, so the raw file can be dropped in and
      // Detect run straight away. Needs a label, except on the first source.
      if (!sourceId) {
        const createBtn = document.createElement("button");
        createBtn.type = "button";
        createBtn.className = "detect-btn";
        createBtn.textContent = "Create folder";
        createBtn.title = "Create this source and its raw data folder now";
        const syncCreateBtn = () => {
          createBtn.disabled = !labelInput.value.trim() && modalBlocks[0] !== blockState;
        };
        syncCreateBtn();
        labelInput.addEventListener("input", syncCreateBtn);
        createBtn.onclick = async () => {
          const statusEl = document.getElementById("modal-save-status");
          const res = await postJson("api/generate", { row_index: modalRowIndex, label: labelInput.value.trim() });
          if (!res.ok) {
            statusEl.textContent = res.error || "Failed to create source";
            return;
          }
          blockState.sourceId = res.source_id;
          pathLine.textContent = `editing: ${sourcesDir}/${res.source_id}/metadata.yaml`;
          labelInput.disabled = true;
          labelInput.classList.remove("required-empty");
          createBtn.remove();
          statusEl.textContent = `Created ${res.source_id} and its raw data folder — drop the file in, then Detect.`;
        };
        labelRow.appendChild(createBtn);
      }

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
  // Everything but the dataset link carries over (licence, contact…) —
  // the row's Data URL is the first source's, not this one's.
  addSourceBlock(null, { ...modalNewSourceDefaults, dataset_page_url: "" });
  refreshBlockChrome();
});
