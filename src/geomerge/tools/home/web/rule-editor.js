// Single-target column-matching-rule editor view — a unified list of terms,
// each tagged exact/contains/excludes, with one control to add a new term
// and a per-row remove. Shared between setup/column_matching_rules.js (the
// standalone editor page, where this is the only view) and column_mapping's
// Prepare page (where it's the second view of a two-view modal, reached by
// picking a target from a list view first — see column_mapping/web/
// rules-modal.js). One implementation instead of two so a future fix/tweak
// doesn't need to be made twice. Loaded via an absolute
// <script src="/rule-editor.js">, same reasoning as nav.js: one copy, not
// one per tool.
//
// Operates on a fixed set of element ids every host page provides:
// #rule-terms-body, #rule-new-term, #rule-new-type, #rule-save-status. The
// API path is absolute (/setup/api/...) rather than relative, since this
// script runs from pages served under other tools' own url_prefix too.
let ruleEditorTerms = []; // [{term, type}], type in {exact, contains, excludes}

const RULE_TERM_TYPE_LABELS = { exact: "Exact", contains: "Contains", excludes: "Excludes" };

function ruleEditorFill(target) {
  ruleEditorTerms = [
    ...(target.exact || []).map((term) => ({ term, type: "exact" })),
    ...(target.contains || []).map((term) => ({ term, type: "contains" })),
    ...(target.excludes || []).map((term) => ({ term, type: "excludes" })),
  ];
  document.getElementById("rule-new-term").value = "";
  document.getElementById("rule-save-status").textContent = "";
  renderRuleTerms();
}

function renderRuleTerms() {
  const body = document.getElementById("rule-terms-body");
  body.innerHTML = "";

  if (ruleEditorTerms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No rules yet.";
    body.appendChild(empty);
    return;
  }

  ruleEditorTerms.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "rule-term-row";

    const text = document.createElement("span");
    text.className = "rule-term-text";
    text.textContent = entry.term;
    row.appendChild(text);

    const badge = document.createElement("span");
    badge.className = `rule-term-type rule-term-type-${entry.type}`;
    badge.textContent = RULE_TERM_TYPE_LABELS[entry.type] || entry.type;
    row.appendChild(badge);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      ruleEditorTerms.splice(i, 1);
      renderRuleTerms();
    });
    row.appendChild(removeBtn);

    body.appendChild(row);
  });
}

// Called by each host page's own "+ Add" button/Enter-key wiring (not
// wired here — keeps this file pure logic/rendering, same convention as
// every other shared script in this app).
function ruleEditorAddTerm() {
  const input = document.getElementById("rule-new-term");
  const term = input.value.trim();
  if (!term) return;
  const type = document.getElementById("rule-new-type").value;
  ruleEditorTerms.push({ term, type });
  input.value = "";
  renderRuleTerms();
  input.focus();
}

// Returns the saved {exact, contains, excludes} on success, or null on
// failure (with the failure message already written into #rule-save-status).
async function ruleEditorSave(targetName) {
  const statusEl = document.getElementById("rule-save-status");
  statusEl.textContent = "Saving…";

  const exact = ruleEditorTerms.filter((t) => t.type === "exact").map((t) => t.term);
  const contains = ruleEditorTerms.filter((t) => t.type === "contains").map((t) => t.term);
  const excludes = ruleEditorTerms.filter((t) => t.type === "excludes").map((t) => t.term);

  const res = await fetch(`/setup/api/column-matching-rules/${encodeURIComponent(targetName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exact, contains, excludes }),
  });

  if (!res.ok) {
    statusEl.textContent = "Failed to save";
    return null;
  }
  return { exact, contains, excludes };
}
