// Two-view "edit column matching rules without leaving Prepare" modal —
// list view (same shape as setup/column_matching_rules.js's page) then, on
// picking a target, the shared single-target editor (see /rule-editor.js).
// No per-row "edit rule" affordance in the main table on purpose (kept the
// table itself uncluttered) — a single link above the table opens this
// instead, and since it isn't scoped to one row, it always starts at the
// full target list rather than jumping straight to an edit view.
let ruleTargets = [];
let activeRuleTarget = null;

async function loadRuleTargets() {
  const res = await fetch("/setup/api/column-matching-rules");
  ruleTargets = await res.json();
}

function hasRules(t) {
  return t.exact.length || t.contains.length || t.excludes.length || t.excludes_contains.length;
}

function ruleSummary(t) {
  const parts = [];
  if (t.exact.length) parts.push(`${t.exact.length} exact`);
  if (t.contains.length) parts.push(`${t.contains.length} contains`);
  if (t.excludes.length) parts.push(`${t.excludes.length} excludes`);
  if (t.excludes_contains.length) parts.push(`${t.excludes_contains.length} excludes (contains)`);
  return parts.length ? parts.join(", ") : "no rules yet";
}

function renderRuleTargetRow(t) {
  const row = document.createElement("div");
  row.className = "target-row";

  const content = document.createElement("div");
  content.className = "target-row-content";

  const name = document.createElement("div");
  name.className = "target-name";
  name.textContent = t.name;
  content.appendChild(name);

  if (t.description) {
    const desc = document.createElement("div");
    desc.className = "target-description";
    desc.textContent = t.description;
    content.appendChild(desc);
  }

  const summary = document.createElement("div");
  summary.className = "target-summary" + (hasRules(t) ? "" : " target-summary-empty");
  summary.textContent = ruleSummary(t);
  content.appendChild(summary);

  row.appendChild(content);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => showRuleEditView(t));
  row.appendChild(editBtn);

  return row;
}

function renderRuleTargetsList() {
  const body = document.getElementById("rules-targets-body");
  body.innerHTML = "";
  for (const t of ruleTargets) {
    body.appendChild(renderRuleTargetRow(t));
  }
}

function showRuleListView() {
  activeRuleTarget = null;
  document.getElementById("rules-modal-title").textContent = "Column matching rules";
  document.getElementById("rules-list-view").classList.remove("hidden");
  document.getElementById("rules-edit-view").classList.add("hidden");
}

function showRuleEditView(t) {
  activeRuleTarget = t;
  document.getElementById("rules-modal-title").textContent = t.name;
  ruleEditorFill(t);
  document.getElementById("rules-list-view").classList.add("hidden");
  document.getElementById("rules-edit-view").classList.remove("hidden");
}

async function openRulesModal() {
  document.getElementById("rules-modal").classList.remove("hidden");
  await loadRuleTargets();
  renderRuleTargetsList();
  showRuleListView();
}

function closeRulesModal() {
  document.getElementById("rules-modal").classList.add("hidden");
  activeRuleTarget = null;
}

async function saveActiveRuleTarget() {
  const saved = await ruleEditorSave(`/setup/api/column-matching-rules/${encodeURIComponent(activeRuleTarget.name)}`);
  if (!saved) return;
  activeRuleTarget.exact = saved.exact;
  activeRuleTarget.contains = saved.contains;
  activeRuleTarget.excludes = saved.excludes;
  activeRuleTarget.excludes_contains = saved.excludes_contains;
  renderRuleTargetsList();
  showRuleListView();
  await refreshAutoSuggestions();
}

document.getElementById("rules-edit-link").addEventListener("click", openRulesModal);
document.getElementById("rules-modal-close").addEventListener("click", closeRulesModal);
document.getElementById("rules-modal").addEventListener("click", (e) => {
  if (e.target.id === "rules-modal") closeRulesModal();
});
document.getElementById("rules-back-btn").addEventListener("click", showRuleListView);
document.getElementById("rule-save-btn").addEventListener("click", saveActiveRuleTarget);
document.getElementById("rule-add-btn").addEventListener("click", ruleEditorAddTerm);
document.getElementById("rule-new-term").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ruleEditorAddTerm();
  }
});
