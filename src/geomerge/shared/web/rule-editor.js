// Single-target column-matching-rule editor view — a unified list of terms,
// each tagged with a behavior (match/exclude) and a mode (exact/contains),
// with one control to add a new term and a per-row remove. Shared between
// setup/column_matching_rules.js (the standalone editor page, where this is
// the only view) and column_mapping's Prepare page (where it's the second
// view of a two-view modal, reached by picking a target from a list view
// first — see column_mapping/web/rules-modal.js). One implementation instead
// of two so a future fix/tweak doesn't need to be made twice. Loaded via an
// absolute <script src="/rule-editor.js">, same reasoning as nav.js: one
// copy, not one per tool.
//
// Behavior x mode is stored/sent as four flat YAML buckets (exact, contains,
// excludes, excludes_contains) — not two lists of {term, mode} objects —
// since that's an additive change to the existing three-bucket shape
// (matching.py already understands it that way) rather than a schema
// migration. The behavior/mode split only exists at the UI layer: two
// independent selectors when adding a term, and two small badges per row,
// rather than one 4-item dropdown/label — "does this match or block?" and
// "exact name or substring?" are two separate questions, and showing them
// as one compound label (e.g. "excludes-contains") makes you parse it every
// time instead of reading it at a glance.
//
// Operates on a fixed set of element ids every host page provides:
// #rule-terms-body, #rule-new-term, #rule-new-behavior, #rule-new-mode,
// #rule-save-status. The API path is absolute (/setup/api/...) rather than
// relative, since this script runs from pages served under other tools' own
// url_prefix too.
let ruleEditorTerms = []; // [{term, type}], type in {exact, contains, excludes, excludes_contains}

// type (the YAML bucket name) <-> {behavior, mode} (the two UI axes).
const RULE_TERM_TYPE_INFO = {
  exact: { behavior: "match", mode: "exact" },
  contains: { behavior: "match", mode: "contains" },
  excludes: { behavior: "exclude", mode: "exact" },
  excludes_contains: { behavior: "exclude", mode: "contains" },
};

function ruleTermType(behavior, mode) {
  if (behavior === "exclude") return mode === "exact" ? "excludes" : "excludes_contains";
  return mode === "exact" ? "exact" : "contains";
}

function ruleEditorFill(target) {
  ruleEditorTerms = [
    ...(target.exact || []).map((term) => ({ term, type: "exact" })),
    ...(target.contains || []).map((term) => ({ term, type: "contains" })),
    ...(target.excludes || []).map((term) => ({ term, type: "excludes" })),
    ...(target.excludes_contains || []).map((term) => ({ term, type: "excludes_contains" })),
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

    const { behavior, mode } = RULE_TERM_TYPE_INFO[entry.type];

    const behaviorBadge = document.createElement("span");
    behaviorBadge.className = `rule-term-behavior rule-term-behavior-${behavior}`;
    behaviorBadge.textContent = behavior === "match" ? "Match" : "Exclude";
    row.appendChild(behaviorBadge);

    const modeBadge = document.createElement("span");
    modeBadge.className = `rule-term-mode rule-term-mode-${mode}`;
    modeBadge.textContent = mode === "exact" ? "Exact" : "Contains";
    row.appendChild(modeBadge);

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
  const behavior = document.getElementById("rule-new-behavior").value;
  const mode = document.getElementById("rule-new-mode").value;
  ruleEditorTerms.push({ term, type: ruleTermType(behavior, mode) });
  input.value = "";
  renderRuleTerms();
  input.focus();
}

// Returns the saved {exact, contains, excludes, excludes_contains} on
// success, or null on failure (with the failure message already written
// into #rule-save-status). Takes the full save URL rather than just a
// target name — column mapping's rules key by target field name alone
// (/setup/api/column-matching-rules/<target>), but classification's are one
// level deeper, keyed by (target, value) (/setup/api/classification-
// matching-rules/<target>/<value>) — passing the whole URL keeps this one
// implementation reusable by both shapes instead of hardcoding either.
async function ruleEditorSave(url) {
  const statusEl = document.getElementById("rule-save-status");
  statusEl.textContent = "Saving…";

  const byType = (type) => ruleEditorTerms.filter((t) => t.type === type).map((t) => t.term);
  const exact = byType("exact");
  const contains = byType("contains");
  const excludes = byType("excludes");
  const excludesContains = byType("excludes_contains");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exact, contains, excludes, excludes_contains: excludesContains }),
  });

  if (!res.ok) {
    statusEl.textContent = "Failed to save";
    return null;
  }
  return { exact, contains, excludes, excludes_contains: excludesContains };
}
