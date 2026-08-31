// Fields are edited by mutating these objects directly (not reconstructed
// from a fixed list of known keys at save time) — this is what lets a key
// the UI has no dedicated control for (e.g. today, only geometry_type/crs)
// survive a save untouched instead of being silently dropped.
let schemaName = "";
let schemaDescription = "";
let fields = [];

// Every save is still whole-document (see save() — one POST with the
// entire fields array, same as every other save in this app), but each row's
// own Save button only lights up for that row's own pending edit, tracked
// by field object identity (fields keeps the same object references across
// re-renders unless a field is actually added/removed, so this survives a
// render() triggered by editing a *different* row — a plain local variable
// inside renderFieldRow wouldn't, since render() rebuilds every row's
// closures from scratch). structuralChange covers add/remove: a deletion
// has no row left to "own" the pending change, so once the field list
// itself has changed shape, every remaining row's Save can carry it
// through — clicking any of them saves the current list either way.
let dirtyFields = new Set();
let structuralChange = false;
let isSaving = false;
let rowSaveButtons = new Map(); // field -> its <button class="row-save-btn">, rebuilt fresh each render()
let draggedField = null; // set for the duration of a drag — see renderFieldRow's drag-handle wiring

function fieldSaveEnabled(field) {
  const hasBlankName = fields.some((f) => !f.name.trim());
  return (dirtyFields.has(field) || structuralChange) && !isSaving && !hasBlankName;
}

// A blank name anywhere blocks every row's Save (the whole-document save
// would otherwise ship an unnamed field), so typing one has to refresh
// every OTHER row's button too, not just the row being typed into.
function refreshAllRowSaveButtons() {
  for (const [field, btn] of rowSaveButtons) {
    btn.disabled = !fieldSaveEnabled(field);
  }
}

const KNOWN_FIELD_KEYS = [
  "name", "type", "required", "source_mappable", "description",
  "categories", "geometry_type", "crs", "_usage", "_originalName",
];

// Only sets --nav-height (the sticky header's own `top` offset) — unlike
// the per-source review pages, there's no scrollable table region below to
// also reserve space for, just a naturally-flowing list of field rows.
function updateStickyOffsets() {
  const nav = document.querySelector(".geomerge-nav");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
}
window.addEventListener("resize", updateStickyOffsets);
updateStickyOffsets();

function markDirty(field) {
  dirtyFields.add(field);
  refreshAllRowSaveButtons();
}

async function load() {
  const res = await fetch("api/schema/fields");
  const data = await res.json();
  schemaName = data.name;
  schemaDescription = data.description;
  // _originalName is stamped once per load, separate from the editable
  // .name — the diff between them is exactly what "this row is being
  // renamed" means, both for the live risky-row styling and (server-side,
  // independently) for the confirmation flow at save time.
  fields = data.fields.map((f) => ({ ...f, _originalName: f.name }));
  dirtyFields = new Set();
  structuralChange = false;
  render();
}

function usageDescription(usage) {
  const parts = [];
  if (usage.column_map_count) parts.push(`${usage.column_map_count} column map${usage.column_map_count === 1 ? "" : "s"}`);
  if (usage.classification_target_count) parts.push(`${usage.classification_target_count} classification target${usage.classification_target_count === 1 ? "" : "s"}`);
  if (usage.classification_source_column_count) parts.push(`${usage.classification_source_column_count} classification source column${usage.classification_source_column_count === 1 ? "" : "s"}`);
  if (usage.config_target) parts.push("config target");
  if (usage.config_source_column_of.length) parts.push(`source column of ${usage.config_source_column_of.join(", ")}`);
  if (usage.column_matching_rule) parts.push("column matching rule");
  if (usage.classification_matching_rule_values.length) parts.push("classification matching rule");
  return parts.length ? `used: ${parts.join(", ")}` : "unused";
}

function checkboxLabel(text, obj, key, tooltip) {
  const label = document.createElement("label");
  label.className = "checkbox";
  if (tooltip) label.title = tooltip;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!obj[key];
  input.addEventListener("change", () => {
    if (input.checked) obj[key] = true;
    else delete obj[key];
    markDirty(obj);
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(text));
  return label;
}

// "Categorical" isn't a plain boolean field key like required/source_mappable
// — it's really "does .categories exist at all" — so it gets its own
// handler rather than reusing checkboxLabel's simple truthy-key toggle.
function categoricalCheckbox(field) {
  const label = document.createElement("label");
  label.className = "checkbox";
  label.title = "Has a fixed list of allowed categories, editable below.";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = field.categories !== undefined;
  input.addEventListener("change", () => {
    if (input.checked) field.categories = field.categories || [];
    else delete field.categories;
    markDirty(field);
    render();
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode("Categorical"));
  return label;
}

function smallTextInput(placeholder, obj, key) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = obj[key] || "";
  input.style.width = "140px";
  input.addEventListener("input", () => {
    if (input.value) obj[key] = input.value;
    else delete obj[key];
    markDirty(obj);
  });
  return input;
}

// Categories are code/label/description records (schema/ccnd.yaml's
// `categories`, see setup/web/server.py) — always shown in full (a code/
// label/description this important is worth the real estate; a collapsed
// summary just hid what you came here to check). A header row names the
// three columns since, once every row is actually filled in, three bare
// text inputs in a row give no clue which is which.
function renderCategoriesEditor(field) {
  const wrap = document.createElement("div");
  wrap.className = "categories-editor";

  if (field.categories.length) {
    const header = document.createElement("div");
    header.className = "category-row category-header";
    const codeHeader = document.createElement("span");
    codeHeader.className = "category-code";
    codeHeader.textContent = "Code";
    header.appendChild(codeHeader);
    const labelHeader = document.createElement("span");
    labelHeader.className = "category-label";
    labelHeader.textContent = "Label";
    header.appendChild(labelHeader);
    const descHeader = document.createElement("span");
    descHeader.className = "category-description";
    descHeader.textContent = "Description";
    header.appendChild(descHeader);
    const spacer = document.createElement("span");
    spacer.className = "category-header-spacer";
    header.appendChild(spacer);
    wrap.appendChild(header);
  }

  for (const category of field.categories) {
    const row = document.createElement("div");
    row.className = "category-row";

    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.className = "category-code";
    codeInput.placeholder = "code";
    codeInput.value = category.code || "";
    codeInput.addEventListener("input", () => {
      category.code = codeInput.value;
      markDirty(field);
    });
    row.appendChild(codeInput);

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "category-label";
    labelInput.placeholder = "label";
    labelInput.value = category.label || "";
    labelInput.addEventListener("input", () => {
      if (labelInput.value) category.label = labelInput.value;
      else delete category.label;
      markDirty(field);
    });
    row.appendChild(labelInput);

    const descInput = document.createElement("input");
    descInput.type = "text";
    descInput.className = "category-description";
    descInput.placeholder = "description";
    descInput.value = category.description || "";
    descInput.addEventListener("input", () => {
      if (descInput.value) category.description = descInput.value;
      else delete category.description;
      markDirty(field);
    });
    row.appendChild(descInput);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-danger";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this category";
    removeBtn.addEventListener("click", () => {
      field.categories = field.categories.filter((c) => c !== category);
      markDirty(field);
      render();
    });
    row.appendChild(removeBtn);

    wrap.appendChild(row);
  }

  const controls = document.createElement("div");
  controls.className = "categories-controls";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+ Add category";
  addBtn.addEventListener("click", () => {
    field.categories.push({ code: "" });
    markDirty(field);
    render();
  });
  controls.appendChild(addBtn);

  wrap.appendChild(controls);
  return wrap;
}

// Only the two things that are unambiguously "not done yet" for a field —
// not a style opinion (e.g. short descriptions are fine) — since the whole
// point is flagging missing essentials, not nagging about everything.
function fieldWarningText(field) {
  const issues = [];
  if (!field.description) issues.push("missing description");
  if (field.categories !== undefined && field.categories.length === 0) issues.push("no categories yet");
  return issues.join(" · ");
}

function renderFieldRow(field) {
  const row = document.createElement("div");
  row.className = "field-row";

  const renamed = field.name !== field._originalName;
  const wasInUse = Boolean(field._usage && field._usage.in_use);
  const risky = renamed && wasInUse;
  row.classList.toggle("is-risky", risky);

  // Drag handle — deliberately its own small element, not the whole row,
  // so pressing into a text input/select to edit or select text never gets
  // mistaken for a drag start. Field order isn't read positionally anywhere
  // in the pipeline (matching/classification/every pipeline step look
  // fields up by name), so reordering only affects the final output's
  // column order and this editor's own readability — nothing to break.
  const dragHandle = document.createElement("div");
  dragHandle.className = "drag-handle";
  dragHandle.title = "Drag to reorder";
  dragHandle.textContent = "⠿";
  dragHandle.draggable = true;
  dragHandle.addEventListener("dragstart", (e) => {
    draggedField = field;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  dragHandle.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    draggedField = null;
  });
  row.appendChild(dragHandle);

  row.addEventListener("dragover", (e) => {
    if (!draggedField || draggedField === field) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drag-over");
    if (!draggedField || draggedField === field) return;
    const fromIdx = fields.indexOf(draggedField);
    fields.splice(fromIdx, 1);
    const toIdx = fields.indexOf(field); // recomputed after removal, so it's correct dragging either direction
    fields.splice(toIdx, 0, draggedField);
    // No single row "owns" a reorder any more than a removal does — see
    // structuralChange's own comment — so any row's Save can commit it.
    structuralChange = true;
    render();
  });

  const content = document.createElement("div");
  content.className = "field-row-content";

  // Line 1: identity + flags.
  const line1 = document.createElement("div");
  line1.className = "field-row-line";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "field-name";
  nameInput.value = field.name;
  nameInput.placeholder = "field_name";
  nameInput.addEventListener("input", () => {
    field.name = nameInput.value;
    // Not a full render() — that rebuilds every row's DOM from scratch on
    // every keystroke, which drops this input's focus mid-typing (only the
    // first character of anything typed would ever land). Toggle the
    // already-rendered risky styling directly instead.
    const nowRisky = field.name !== field._originalName && wasInUse;
    row.classList.toggle("is-risky", nowRisky);
    const badge = content.querySelector(".usage-badge");
    if (badge) badge.classList.toggle("is-risky", nowRisky);
    markDirty(field);
  });
  line1.appendChild(nameInput);

  const typeSelect = document.createElement("select");
  typeSelect.className = "field-type";
  for (const t of ["string", "integer", "float", "geometry"]) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    if (field.type === t) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", () => {
    field.type = typeSelect.value;
    markDirty(field);
    render();
  });
  line1.appendChild(typeSelect);

  line1.appendChild(checkboxLabel("Required", field, "required"));
  line1.appendChild(checkboxLabel(
    "Mapped from source",
    field,
    "source_mappable",
    "Can be assigned a raw column in the column-mapping tool — turn this on for any field a source's raw data actually fills in."
  ));
  line1.appendChild(categoricalCheckbox(field));

  const warningBadge = document.createElement("span");
  warningBadge.className = "field-warning";
  const updateWarning = () => {
    const text = fieldWarningText(field);
    warningBadge.textContent = text;
    warningBadge.classList.toggle("hidden", !text);
  };
  updateWarning();
  line1.appendChild(warningBadge);

  content.appendChild(line1);

  // geometry_type/crs ride along with the identity line — rare (today,
  // only the one geometry field) and tightly coupled to the type dropdown
  // right above, rather than a whole line of their own.
  if (field.type === "geometry" || field.geometry_type !== undefined || field.crs !== undefined) {
    const geomLine = document.createElement("div");
    geomLine.className = "field-row-line";
    geomLine.appendChild(smallTextInput("geometry_type", field, "geometry_type"));
    geomLine.appendChild(smallTextInput("crs", field, "crs"));
    content.appendChild(geomLine);
  }

  // Line 2: description.
  const descInput = document.createElement("input");
  descInput.type = "text";
  descInput.className = "field-description";
  descInput.placeholder = "description";
  descInput.value = field.description || "";
  descInput.addEventListener("input", () => {
    if (descInput.value) field.description = descInput.value;
    else delete field.description;
    updateWarning();
    markDirty(field);
  });
  content.appendChild(descInput);

  // Line 3: categories, only when categorical.
  if (field.categories !== undefined) {
    content.appendChild(renderCategoriesEditor(field));
  }

  const otherKeys = Object.keys(field).filter((k) => !KNOWN_FIELD_KEYS.includes(k));
  if (otherKeys.length) {
    const otherWrap = document.createElement("div");
    otherWrap.className = "meta";
    otherWrap.textContent = "Other: " + otherKeys.map((k) => `${k}=${field[k]}`).join(", ");
    content.appendChild(otherWrap);
  }

  // Line 4: usage.
  if (field._usage) {
    const badge = document.createElement("span");
    badge.className = "usage-badge" + (risky ? " is-risky" : "");
    badge.textContent = usageDescription(field._usage);
    if (risky) badge.title = "Renaming away from its original name will affect the sources/config above.";
    content.appendChild(badge);
  }

  row.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "field-row-actions";

  // Whole-document save() (see save() — one POST with every field, same as
  // every other save in this app), but this button's own enabled state only
  // reflects THIS field's pending edit (fieldSaveEnabled) — see the big
  // comment at the top of the file on why that needs dirtyFields rather
  // than a plain local variable.
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "row-save-btn";
  saveBtn.textContent = "Save";
  saveBtn.disabled = !fieldSaveEnabled(field);
  saveBtn.addEventListener("click", () => save());
  rowSaveButtons.set(field, saveBtn);
  actions.appendChild(saveBtn);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    fields = fields.filter((f) => f !== field);
    // A deletion has no row left of its own to carry it — see
    // structuralChange's own comment up top.
    structuralChange = true;
    render();
  });
  actions.appendChild(removeBtn);

  row.appendChild(actions);

  return row;
}

function render() {
  const body = document.getElementById("fields-body");
  body.innerHTML = "";
  rowSaveButtons.clear(); // every row's closures (and its Save button) are rebuilt fresh below
  for (const field of fields) {
    body.appendChild(renderFieldRow(field));
  }
  document.getElementById("field-count").textContent = `${fields.length} field${fields.length === 1 ? "" : "s"} defined`;
}

// _usage is purely a display concern (the server recomputes it fresh every
// GET, no need to send it back). _original_name is kept, renamed to match
// the server's snake_case — the server needs it to tell "renamed" from
// "brand new field" when correlating against the on-disk schema, since a
// field can be renamed AND have its enum edited in the same save (the
// server strips this back out before it can reach the actual file).
function stripInternalKeys(field) {
  const clean = { ...field };
  delete clean._usage;
  delete clean._originalName;
  clean._original_name = field._originalName;
  return clean;
}

function sourceList(ids, max = 8) {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")}, +${ids.length - max} more`;
}

function mergeAcked(existing, additional) {
  const merged = { ...existing };
  for (const [fname, values] of Object.entries(additional)) {
    merged[fname] = [...(merged[fname] || []), ...values];
  }
  return merged;
}

// Every field row has its own Save trigger (see renderFieldRow) — disable
// all of them for the duration so a second click mid-flight can't fire an
// overlapping save, same reasoning as every other multi-step save flow in
// this app.
function setSchemaSaving(inProgress) {
  isSaving = inProgress;
  refreshAllRowSaveButtons();
}

// Replaces a plain window.confirm() with the same modal chrome as every
// other confirmation in this app — the risky-removal warning can be long
// (many affected sources), which a native confirm() renders as an
// unstyled, unscrollable OS dialog. Resolves true ("Save anyway") or false
// (Cancel/close) — save() awaits it exactly where confirm() used to be.
let pendingRiskyResolve = null;

function renderRiskyDetail(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

function showRiskyModal(data) {
  const body = document.getElementById("risky-save-body");
  body.innerHTML = "";

  for (const [name, detail] of Object.entries(data.unacknowledged_removed_fields || {})) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = name;
    item.appendChild(strong);

    const sub = document.createElement("ul");
    if (detail.column_map_sources.length) {
      sub.appendChild(renderRiskyDetail(`column_map.yaml in ${detail.column_map_sources.length} source(s): ${sourceList(detail.column_map_sources)}`));
    }
    if (detail.classification_target_sources.length) {
      sub.appendChild(renderRiskyDetail(`a classification target in ${detail.classification_target_sources.length} source(s): ${sourceList(detail.classification_target_sources)}`));
    }
    if (detail.classification_source_column_sources.length) {
      sub.appendChild(renderRiskyDetail(`a classification source column in ${detail.classification_source_column_sources.length} source(s)`));
    }
    if (detail.config_target) sub.appendChild(renderRiskyDetail("a classification target in geomerge.config.yaml"));
    if (detail.config_source_column_of.length) {
      sub.appendChild(renderRiskyDetail(`a source column of ${detail.config_source_column_of.join(", ")} in geomerge.config.yaml`));
    }
    if (detail.column_matching_rule) sub.appendChild(renderRiskyDetail("has a column matching rule"));
    if (detail.classification_matching_rule_values.length) sub.appendChild(renderRiskyDetail("has classification matching rules"));
    item.appendChild(sub);

    body.appendChild(item);
  }

  for (const [fname, values] of Object.entries(data.unacknowledged_removed_enum_values || {})) {
    for (const [value, sources] of Object.entries(values)) {
      const item = document.createElement("li");
      item.textContent = `${fname}: "${value}" is a saved answer for ${sources.length} source(s): ${sourceList(sources)}`;
      body.appendChild(item);
    }
  }

  document.getElementById("risky-save-modal").classList.remove("hidden");
}

function riskyModalConfirm(data) {
  return new Promise((resolve) => {
    pendingRiskyResolve = resolve;
    showRiskyModal(data);
  });
}

function resolveRiskyModal(confirmed) {
  document.getElementById("risky-save-modal").classList.add("hidden");
  if (pendingRiskyResolve) {
    pendingRiskyResolve(confirmed);
    pendingRiskyResolve = null;
  }
}

async function save(acknowledgedFields = [], acknowledgedEnumValues = {}) {
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "Saving…";
  setSchemaSaving(true);

  const res = await fetch("api/schema/fields", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: schemaName,
      description: schemaDescription,
      fields: fields.map(stripInternalKeys),
      acknowledged_removed_fields: acknowledgedFields,
      acknowledged_removed_enum_values: acknowledgedEnumValues,
    }),
  });
  const data = await res.json();

  if (res.status === 400 && (data.unacknowledged_removed_fields || data.unacknowledged_removed_enum_values)) {
    const confirmed = await riskyModalConfirm(data);
    if (confirmed) {
      const ackFields = Object.keys(data.unacknowledged_removed_fields || {});
      const ackEnum = {};
      for (const [fname, values] of Object.entries(data.unacknowledged_removed_enum_values || {})) {
        ackEnum[fname] = Object.keys(values);
      }
      return save([...acknowledgedFields, ...ackFields], mergeAcked(acknowledgedEnumValues, ackEnum));
    }
    statusEl.textContent = "Not saved.";
    setSchemaSaving(false);
    return;
  }

  if (!res.ok) {
    statusEl.textContent = data.error || "Failed to save";
    setSchemaSaving(false);
    return;
  }

  statusEl.textContent = "Saved.";
  isSaving = false; // load() below resets dirtyFields/structuralChange and re-renders every button fresh
  await load(); // fresh usage info against the schema as it now stands on disk
}

document.getElementById("add-field-btn").addEventListener("click", () => {
  fields.push({ name: "", type: "string" });
  // A new field has no prior saved state to be "dirty" relative to, but the
  // list itself just changed shape — see structuralChange's own comment.
  structuralChange = true;
  render();
});

document.getElementById("risky-save-close").addEventListener("click", () => resolveRiskyModal(false));
document.getElementById("risky-save-cancel-btn").addEventListener("click", () => resolveRiskyModal(false));
document.getElementById("risky-save-confirm-btn").addEventListener("click", () => resolveRiskyModal(true));
document.getElementById("risky-save-modal").addEventListener("click", (e) => {
  if (e.target.id === "risky-save-modal") resolveRiskyModal(false);
});

load();
