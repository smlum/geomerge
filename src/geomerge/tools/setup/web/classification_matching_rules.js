// Two-tier editor: a row of tabs (one per classification target, same
// .target-tabs styling classification's own review.html tab bar uses),
// then a list of that target's enum values, each opening the shared
// /rule-editor.js modal (exact/contains/excludes/excludes_contains) scoped
// to that one (target, value) pair. One tier deeper than column mapping's
// equivalent editor, since a classification rule matches a raw *value*
// onto a target's enum code, not a raw column name onto a target field.
let targets = [];
let activeTargetName = null;
let activeValueCode = null;

async function load() {
  const res = await fetch("api/classification-matching-rules");
  const data = await res.json();
  targets = data.targets;

  const requested = new URLSearchParams(location.search).get("target");
  activeTargetName = targets.find((t) => t.name === requested) ? requested : targets[0] && targets[0].name;

  renderTabs();
  renderValues();
  renderSummary();
}

function activeTarget() {
  return targets.find((t) => t.name === activeTargetName);
}

function hasRules(valueRules) {
  return valueRules.exact.length || valueRules.contains.length || valueRules.excludes.length || valueRules.excludes_contains.length;
}

function ruleSummary(valueRules) {
  const parts = [];
  if (valueRules.exact.length) parts.push(`${valueRules.exact.length} exact`);
  if (valueRules.contains.length) parts.push(`${valueRules.contains.length} contains`);
  if (valueRules.excludes.length) parts.push(`${valueRules.excludes.length} excludes`);
  if (valueRules.excludes_contains.length) parts.push(`${valueRules.excludes_contains.length} excludes (contains)`);
  return parts.length ? parts.join(", ") : "no rules yet";
}

function setActiveTargetName(name) {
  activeTargetName = name;
  renderTabs();
  renderValues();
}

function renderTabs() {
  const bar = document.getElementById("cmr-target-tabs");
  bar.innerHTML = "";
  for (const t of targets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "target-tab" + (t.name === activeTargetName ? " active" : "");

    const label = document.createElement("span");
    label.className = "target-tab-label";
    label.textContent = t.name;
    btn.appendChild(label);

    btn.addEventListener("click", () => setActiveTargetName(t.name));
    bar.appendChild(btn);
  }
}

function renderValues() {
  const body = document.getElementById("cmr-values-body");
  body.innerHTML = "";
  const t = activeTarget();
  if (!t) return;

  if (t.source_columns.length) {
    const cols = document.createElement("div");
    cols.className = "meta rules-source-columns";
    cols.textContent = `Matched against: ${t.source_columns[0]}`;
    body.appendChild(cols);
  }

  if (!t.options) {
    const note = document.createElement("div");
    note.className = "meta target-na-note";
    note.textContent = "No enum defined for this target yet — add categories in Setup → Target schema first.";
    body.appendChild(note);
    return;
  }

  for (const opt of t.options) {
    const valueRules = t.values[opt.code];
    const row = document.createElement("div");
    row.className = "target-row";

    const content = document.createElement("div");
    content.className = "target-row-content";

    const name = document.createElement("div");
    name.className = "target-name";
    name.textContent = opt.code;
    content.appendChild(name);

    const summary = document.createElement("div");
    summary.className = "target-summary" + (hasRules(valueRules) ? "" : " target-summary-empty");
    summary.textContent = ruleSummary(valueRules);
    content.appendChild(summary);

    row.appendChild(content);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openRuleModal(opt.code));
    row.appendChild(editBtn);

    body.appendChild(row);
  }
}

function renderSummary() {
  const totalValues = targets.reduce((sum, t) => sum + (t.options ? t.options.length : 0), 0);
  const withRules = targets.reduce(
    (sum, t) => sum + (t.options ? t.options.filter((o) => hasRules(t.values[o.code])).length : 0),
    0
  );
  document.getElementById("rules-summary").textContent = `${withRules} / ${totalValues} values with rules defined`;
}

function openRuleModal(valueCode) {
  activeValueCode = valueCode;
  const t = activeTarget();
  document.getElementById("rule-modal-title").textContent = `${t.name} — ${valueCode}`;
  ruleEditorFill(t.values[valueCode]);
  document.getElementById("rule-modal").classList.remove("hidden");
}

function closeRuleModal() {
  document.getElementById("rule-modal").classList.add("hidden");
  activeValueCode = null;
}

async function saveRule() {
  const t = activeTarget();
  const saved = await ruleEditorSave(
    `/setup/api/classification-matching-rules/${encodeURIComponent(t.name)}/${encodeURIComponent(activeValueCode)}`
  );
  if (!saved) return;
  t.values[activeValueCode] = saved;
  renderValues();
  renderSummary();
  closeRuleModal();
}

document.getElementById("rule-modal-close").addEventListener("click", closeRuleModal);
document.getElementById("rule-modal").addEventListener("click", (e) => {
  if (e.target.id === "rule-modal") closeRuleModal();
});
document.getElementById("rule-save-btn").addEventListener("click", saveRule);
document.getElementById("rule-add-btn").addEventListener("click", ruleEditorAddTerm);
document.getElementById("rule-new-term").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ruleEditorAddTerm();
  }
});

load();
