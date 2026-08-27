// Fields are edited by mutating these objects directly (not reconstructed
// from a fixed list of known keys at save time) — this is what lets a key
// the UI has no dedicated control for (e.g. today, only geometry_type/crs)
// survive a save untouched instead of being silently dropped.
let schemaName = "";
let schemaDescription = "";
let fields = [];

const KNOWN_FIELD_KEYS = [
  "name", "type", "required", "source_mappable", "description",
  "categories", "geometry_type", "crs", "_usage", "_originalName", "_categoriesExpanded",
];

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
    if (input.checked) {
      field.categories = field.categories || [];
      field._categoriesExpanded = true; // land straight in edit mode — an empty list has nothing worth collapsing
    } else {
      delete field.categories;
    }
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
  });
  return input;
}

function categoryLabel(category) {
  return category.label || category.code || "(unnamed)";
}

// Categories are code/label/description records (schema/ccnd.yaml's
// `categories`, see setup/web/server.py) — enough real estate per value
// that every categorical field showing all of it by default would make the
// page unreadable (this is exactly the complaint that got the field-row
// layout redone). Collapsed by default: a one-line summary of labels, with
// an "Edit categories" toggle into the real per-value editor.
function renderCategoriesEditor(field) {
  const wrap = document.createElement("div");
  wrap.className = "categories-editor";

  if (!field._categoriesExpanded) {
    const summary = document.createElement("div");
    summary.className = "categories-summary";
    const list = document.createElement("span");
    list.className = "categories-summary-list";
    list.textContent = field.categories.length ? field.categories.map(categoryLabel).join(", ") : "(no categories yet)";
    summary.appendChild(list);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "link-btn";
    editBtn.textContent = "Edit categories";
    editBtn.addEventListener("click", () => {
      field._categoriesExpanded = true;
      render();
    });
    summary.appendChild(editBtn);

    wrap.appendChild(summary);
    return wrap;
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
    });
    row.appendChild(descInput);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-danger";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this category";
    removeBtn.addEventListener("click", () => {
      field.categories = field.categories.filter((c) => c !== category);
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
    render();
  });
  controls.appendChild(addBtn);

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "link-btn";
  collapseBtn.textContent = "Collapse";
  collapseBtn.addEventListener("click", () => {
    field._categoriesExpanded = false;
    render();
  });
  controls.appendChild(collapseBtn);

  wrap.appendChild(controls);
  return wrap;
}

function renderFieldRow(field) {
  const row = document.createElement("div");
  row.className = "field-row";

  const renamed = field.name !== field._originalName;
  const wasInUse = Boolean(field._usage && field._usage.in_use);
  const risky = renamed && wasInUse;
  row.classList.toggle("is-risky", risky);

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

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    fields = fields.filter((f) => f !== field);
    render();
  });
  row.appendChild(removeBtn);

  return row;
}

function render() {
  const body = document.getElementById("fields-body");
  body.innerHTML = "";
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
  delete clean._categoriesExpanded;
  clean._original_name = field._originalName;
  return clean;
}

function sourceList(ids, max = 8) {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")}, +${ids.length - max} more`;
}

function buildWarningMessage(data) {
  const lines = ["Saving will remove or rename fields/values still referenced by real sources or config:", ""];

  for (const [name, detail] of Object.entries(data.unacknowledged_removed_fields || {})) {
    lines.push(`  ${name}:`);
    if (detail.column_map_sources.length) {
      lines.push(`    - column_map.yaml in ${detail.column_map_sources.length} source(s): ${sourceList(detail.column_map_sources)}`);
    }
    if (detail.classification_target_sources.length) {
      lines.push(`    - a classification target in ${detail.classification_target_sources.length} source(s): ${sourceList(detail.classification_target_sources)}`);
    }
    if (detail.classification_source_column_sources.length) {
      lines.push(`    - a classification source column in ${detail.classification_source_column_sources.length} source(s)`);
    }
    if (detail.config_target) lines.push("    - a classification target in geomerge.config.yaml");
    if (detail.config_source_column_of.length) lines.push(`    - a source column of ${detail.config_source_column_of.join(", ")} in geomerge.config.yaml`);
    if (detail.column_matching_rule) lines.push("    - has a column matching rule");
    if (detail.classification_matching_rule_values.length) lines.push("    - has classification matching rules");
  }

  for (const [fname, values] of Object.entries(data.unacknowledged_removed_enum_values || {})) {
    for (const [value, sources] of Object.entries(values)) {
      lines.push(`  ${fname}: "${value}" is a saved answer for ${sources.length} source(s): ${sourceList(sources)}`);
    }
  }

  lines.push("");
  lines.push("Those files will NOT be updated automatically. Save anyway?");
  return lines.join("\n");
}

function mergeAcked(existing, additional) {
  const merged = { ...existing };
  for (const [fname, values] of Object.entries(additional)) {
    merged[fname] = [...(merged[fname] || []), ...values];
  }
  return merged;
}

async function save(acknowledgedFields = [], acknowledgedEnumValues = {}) {
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "Saving…";

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
    if (confirm(buildWarningMessage(data))) {
      const ackFields = Object.keys(data.unacknowledged_removed_fields || {});
      const ackEnum = {};
      for (const [fname, values] of Object.entries(data.unacknowledged_removed_enum_values || {})) {
        ackEnum[fname] = Object.keys(values);
      }
      return save([...acknowledgedFields, ...ackFields], mergeAcked(acknowledgedEnumValues, ackEnum));
    }
    statusEl.textContent = "Not saved.";
    return;
  }

  if (!res.ok) {
    statusEl.textContent = data.error || "Failed to save";
    return;
  }

  statusEl.textContent = "Saved.";
  await load(); // fresh usage info against the schema as it now stands on disk
}

document.getElementById("add-field-btn").addEventListener("click", () => {
  fields.push({ name: "", type: "string" });
  render();
});

document.getElementById("save-btn").addEventListener("click", () => save());

load();
