let targets = [];
let activeTarget = null;

async function load() {
  const res = await fetch("api/column-matching-rules");
  targets = await res.json();
  render();
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

function renderTargetRow(t) {
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
  editBtn.addEventListener("click", () => openRuleModal(t));
  row.appendChild(editBtn);

  return row;
}

function render() {
  const body = document.getElementById("targets-body");
  body.innerHTML = "";
  for (const t of targets) {
    body.appendChild(renderTargetRow(t));
  }
  const withRules = targets.filter(hasRules).length;
  document.getElementById("rules-summary").textContent =
    `${targets.length} target field${targets.length === 1 ? "" : "s"} · ${withRules} with rules defined`;
}

function openRuleModal(t) {
  activeTarget = t;
  document.getElementById("rule-modal-title").textContent = t.name;
  ruleEditorFill(t);
  document.getElementById("rule-modal").classList.remove("hidden");
}

function closeRuleModal() {
  document.getElementById("rule-modal").classList.add("hidden");
  activeTarget = null;
}

async function saveRule() {
  const saved = await ruleEditorSave(activeTarget.name);
  if (!saved) return;
  activeTarget.exact = saved.exact;
  activeTarget.contains = saved.contains;
  activeTarget.excludes = saved.excludes;
  activeTarget.excludes_contains = saved.excludes_contains;
  render();
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
