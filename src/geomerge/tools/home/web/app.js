function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

// Every source-owned YAML file (metadata.yaml, column_map.yaml,
// classification_map.yaml) gets the same treatment: clicking the status pill
// opens a read-only preview in a modal (see openYamlModal) instead of
// jumping straight into that tool's own edit UI in a new tab — a quick look
// shouldn't cost a tab, and the modal's own "Edit" button is right there if
// a look turns into an edit.
// accent matches the nav tab that owns each file (see nav.css's .tab-*):
// metadata -> Collect, column_map/classification_map -> Prepare (the
// dedicated tab for both stages — see prep/'s server.py docstring).
const YAML_PREVIEWS = {
  metadata: {
    filename: "metadata.yaml",
    fetchUrl: (id) => `/collection/api/source/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `collection/?id=${encodeURIComponent(id)}`,
    accent: "peach",
  },
  column_map: {
    filename: "column_map.yaml",
    fetchUrl: (id) => `/column-mapping/api/column_map/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `column-mapping/map.html?id=${encodeURIComponent(id)}`,
    accent: "purple",
  },
  classification_map: {
    filename: "classification_map.yaml",
    fetchUrl: (id) => `/classification/api/classification/${encodeURIComponent(id)}/raw`,
    editHref: (id) => `classification/review.html?id=${encodeURIComponent(id)}`,
    accent: "purple",
  },
};

function yamlPreviewCell(status, sourceId, kind, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  badge.classList.add("copyable");
  badge.title = `Click to view ${YAML_PREVIEWS[kind].filename}`;
  badge.addEventListener("click", () => openYamlModal(kind, sourceId));
  td.appendChild(badge);
  return td;
}

// No tool exists yet for this stage — a badge, not a link, so there's
// nothing to click through to.
function plainCell(status, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  td.appendChild(statusBadge(status));
  return td;
}

// Raw has no editor of its own, but "complete" means a file's actually sat
// down on disk somewhere — worth a click to confirm exactly where without
// digging through data/raw/ by hand. "missing" stays a plain, inert badge
// (see plainCell) since there's nothing to show.
function rawInfoCell(status, sourceId, rawFilename, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  if (status === "complete") {
    badge.classList.add("copyable");
    badge.title = "Click to view raw file location";
    badge.addEventListener("click", () => openRawInfoModal(sourceId, rawFilename));
  }
  td.appendChild(badge);
  return td;
}

function openRawInfoModal(sourceId, rawFilename) {
  document.getElementById("raw-modal-title").textContent = sourceId;
  document.getElementById("raw-modal-path").textContent = `data/raw/${sourceId}/${rawFilename}`;
  document.getElementById("raw-modal").classList.remove("hidden");
}

function closeRawInfoModal() {
  document.getElementById("raw-modal").classList.add("hidden");
}

document.getElementById("raw-modal-close").addEventListener("click", closeRawInfoModal);
document.getElementById("raw-modal").addEventListener("click", (e) => {
  if (e.target.id === "raw-modal") closeRawInfoModal();
});

// Pipeline stages (preprocessing/processing) have no review UI, but unlike
// raw/validation they do have a real CLI command that fixes them — so when
// there's something to fix (stale or never built), the badge copies that
// command to the clipboard instead of just sitting there as a status.
function pipelineCell(status, sourceId, stage, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const badge = statusBadge(status);
  if (status === "stale" || status === "not_built") {
    const command = `geomerge pipeline ${stage} --source ${sourceId}`;
    badge.classList.add("copyable");
    badge.title = "Click to copy command";
    badge.addEventListener("click", () => copyCommand(badge, command));
  }
  td.appendChild(badge);
  return td;
}

async function copyCommand(badge, command) {
  try {
    await navigator.clipboard.writeText(command);
  } catch (e) {
    return;
  }
  const original = badge.textContent;
  badge.textContent = "copied!";
  setTimeout(() => {
    badge.textContent = original;
  }, 1000);
}

// Cross-blueprint fetch (each tool owns its own YAML file) — absolute path,
// since this page is served from "/", not from that tool's own prefix.
async function openYamlModal(kind, sourceId) {
  const preview = YAML_PREVIEWS[kind];
  document.getElementById("yaml-modal-title").textContent = sourceId;
  document.getElementById("yaml-modal-path").textContent = "";
  const editBtn = document.getElementById("yaml-modal-edit");
  editBtn.href = preview.editHref(sourceId);
  editBtn.className = `edit-btn edit-btn-${preview.accent}`;
  const content = document.getElementById("yaml-modal-content");
  content.textContent = "Loading…";
  document.getElementById("yaml-modal").classList.remove("hidden");

  const res = await fetch(preview.fetchUrl(sourceId));
  if (res.status === 404) {
    content.textContent = `No ${preview.filename} yet for this source.`;
    return;
  }
  const data = await res.json();
  document.getElementById("yaml-modal-path").textContent = data.path;
  content.innerHTML = hljs.highlight(data.content, { language: "yaml" }).value;
}

function closeYamlModal() {
  document.getElementById("yaml-modal").classList.add("hidden");
}

document.getElementById("yaml-modal-close").addEventListener("click", closeYamlModal);
document.getElementById("yaml-modal").addEventListener("click", (e) => {
  if (e.target.id === "yaml-modal") closeYamlModal();
});

// "Complete" means nothing left to do anywhere in the row — every stage
// is either complete or not applicable. Validation is deliberately
// excluded: it's a permanent "not_built" placeholder (see server.py, no
// automated check exists yet), so including it would mean no row could
// ever be "complete".
function isRowComplete(s) {
  const statuses = [
    s.collection.metadata,
    s.collection.raw,
    s.tools.column_mapping,
    s.tools.preprocessing,
    s.tools.classification,
    s.pipeline.processing,
  ];
  return statuses.every((st) => st === "complete" || st === "not_applicable");
}

function nameCell(sourceId) {
  const nameTd = document.createElement("td");
  nameTd.className = "name";
  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "source-card-trigger";
  nameBtn.textContent = sourceId;
  nameBtn.title = sourceId;
  nameBtn.addEventListener("click", () => openSourceCard(sourceId));
  nameTd.appendChild(nameBtn);
  return nameTd;
}

// --- Notes column + popout ---------------------------------------------------
// One note, flag and exclude switch per source (metadata.yaml — see
// helpers/source_notes.py), shared by every stage. The cell shows pills only;
// the full text is on hover and in the popout, which is also where they're
// edited. Provider-level follow-ups (flagged checklist.csv rows, usually with
// no source yet) get the same popout, minus the exclude switch.

function notesPill(text, kind) {
  const span = document.createElement("span");
  span.className = `notes-pill notes-pill-${kind}`;
  span.textContent = text;
  return span;
}

// A flag's reasons, each its own colour (flag_reasons in the project's
// geomerge.config.yaml), or a plain "flagged" until it has any. Unknown
// codes (since dropped from config) still show, as their raw code. What to
// do about it is the separate follow-up status — its own column.
const FLAG_STATUS_LABELS = { contact: "Contact", waiting: "Waiting", review: "Review" };

function reasonInfo(code) {
  return FLAG_REASONS[code] || { label: code.replace(/_/g, " "), color: "overlay1" };
}

function reasonPill(code) {
  const info = reasonInfo(code);
  const pill = notesPill(info.label, "reason");
  pill.style.setProperty("--pill-accent", `var(--ctp-${info.color})`);
  return pill;
}

function flagPills(markers, pen = "") {
  const reasons = markers.flag_reasons || [];
  const pills = reasons.length ? reasons.map(reasonPill) : [notesPill("flagged", "flagged")];
  if (pen) pills[0].textContent += pen;
  return pills;
}

// "contact" with nobody on file yet shows as "find contact" — display only,
// never stored; it turns back into Contact once a contact's saved.
function needsContactFound(markers) {
  return markers.flag_status === "contact" && !markers.has_contact;
}

function statusPill(markers) {
  const status = markers.flag_status;
  const findContact = needsContactFound(markers);
  const label = findContact ? "Find contact" : FLAG_STATUS_LABELS[status] || status;
  const pill = notesPill(label, findContact ? "status-find-contact" : `status-${status}`);
  if (markers.flag_status_date) pill.title = `${FLAG_STATUS_LABELS[status] || status} since ${markers.flag_status_date}`;
  if (findContact) pill.title = `No contact recorded yet${pill.title ? ` · ${pill.title}` : ""}`;
  return pill;
}

// The Follow-up column: a flag's status, or nothing. Opens the same popout.
function followUpCell(markers, onOpen) {
  const td = document.createElement("td");
  td.className = "followup-cell";
  if (!markers.flagged) return td;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-trigger";
  btn.appendChild(statusPill(markers));
  btn.addEventListener("click", onOpen);
  td.appendChild(btn);
  return td;
}

function notesCell(markers, onOpen) {
  const td = document.createElement("td");
  td.className = "notes-cell";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-trigger";
  const pen = markers.notes ? " ✎" : "";
  if (markers.flagged) btn.append(...flagPills(markers, pen));
  if (markers.excluded) btn.appendChild(notesPill(`excluded${markers.flagged ? "" : pen}`, "excluded"));
  if (markers.notes && !markers.flagged && !markers.excluded) btn.appendChild(notesPill("note", "note"));
  // A flagged source's reasons already say what's wrong; its class notes
  // are still in the popout.
  if (markers.class_notes && !markers.flagged) btn.appendChild(notesPill(`${markers.class_notes} class`, "class"));
  if (!btn.childNodes.length) {
    btn.classList.add("notes-empty");
    btn.textContent = "+ note";
  }
  btn.title = markers.notes || (markers.flagged ? "Flagged — no note yet" : "Add a note");
  btn.addEventListener("click", onOpen);
  td.appendChild(btn);
  return td;
}

// The popout opens on a read-only summary (renderNotesSummary) — at a glance:
// what needs doing, where the source stands, its link, whether there's a
// contact, a link to the full metadata. Edit swaps in the fields.
let notesTarget = null; // {kind: "source", source} | {kind: "provider", provider}
let notesView = null; // what the summary shows: {label, note, flagged, flag_reasons, flag_status, flag_status_date, excluded, status, links, contact, providerContact, facts, metaHref, metaText}
let notesSaved = null; // the edit fields as last loaded/saved, for the dirty check

function externalLink(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "notes-link";
  a.textContent = text;
  return a;
}

// An email becomes a mailto: link and a URL a plain link; anything else
// (a phone number, a name) stays as text.
function contactNode(contact) {
  if (/^\S+@\S+\.\S+$/.test(contact)) return externalLink(`mailto:${contact}`, contact);
  if (/^https?:\/\//.test(contact)) return externalLink(contact, contact.replace(/^https?:\/\//, ""));
  return document.createTextNode(contact);
}

// Where a source stands, in one line: excluded, the first stage still to
// do, or done. Read from its row's statuses (source_row in server.py).
function pipelineSummary(s) {
  if (s.markers.excluded) return "Excluded — the pipeline skips it";
  const stages = [
    ["Metadata", s.collection.metadata],
    ["Raw data", s.collection.raw],
    ["Map", s.tools.column_mapping],
    ["Preprocess", s.tools.preprocessing],
    ["Classify", s.tools.classification],
    ["Process", s.pipeline.processing],
  ];
  const next = stages.find(([, status]) => status !== "complete" && status !== "not_applicable");
  if (!next) return "Processed — goes into the merge";
  return `${next[0]}: ${next[1].replace(/_/g, " ")} — not in the merge yet`;
}

function sourceFacts(d) {
  const facts = [];
  if (d.source_updated_date) facts.push(`Updated ${d.source_updated_date}`);
  if (d.license_name || d.license_url) {
    const openness = d.open_license === true ? "open" : d.open_license === false ? "not open" : "openness unset";
    const label = `${d.license_name || "Licence"} (${openness})`;
    facts.push(d.license_url ? externalLink(d.license_url, label) : label);
  } else {
    facts.push("No licence recorded");
  }
  return facts;
}

function renderNotesSummary() {
  const v = notesView;
  const badges = document.getElementById("notes-sum-badges");
  badges.innerHTML = "";
  if (v.flagged) badges.append(...flagPills(v), statusPill(v));
  if (v.excluded) badges.appendChild(notesPill("excluded", "excluded"));
  document.getElementById("notes-sum-status").textContent = v.status || "";

  const noteInput = document.getElementById("notes-modal-text");
  noteInput.value = v.note || "";
  noteInput.placeholder = v.flagged ? "Flagged — add a note saying what needs doing…" : "Add a note…";
  growNoteInput();

  // The dataset page itself, as its own URL (shortened), so it's one click.
  const sourceEl = document.getElementById("notes-sum-source");
  sourceEl.innerHTML = "";
  if (v.sourceUrl) {
    const shown = v.sourceUrl.replace(/^https?:\/\/(www\.)?/, "");
    const a = externalLink(v.sourceUrl, `${shown.length > 60 ? shown.slice(0, 57) + "…" : shown} ↗`);
    a.title = v.sourceUrl;
    sourceEl.appendChild(a);
  } else {
    const missing = document.createElement("span");
    missing.className = "notes-missing";
    missing.textContent = "No page recorded";
    sourceEl.appendChild(missing);
  }

  const linksEl = document.getElementById("notes-sum-links");
  linksEl.innerHTML = "";
  for (const [href, text] of [...v.links, [v.metaHref, v.metaText]]) {
    if (!href) continue;
    if (linksEl.childNodes.length) linksEl.append(" · ");
    linksEl.appendChild(externalLink(href, text));
  }
  const showLinks = linksEl.childNodes.length > 0;
  document.getElementById("notes-sum-links-label").classList.toggle("hidden", !showLinks);
  linksEl.classList.toggle("hidden", !showLinks);

  const showFacts = v.facts.length > 0;
  document.getElementById("notes-sum-facts-label").classList.toggle("hidden", !showFacts);
  const factsEl = document.getElementById("notes-sum-facts");
  factsEl.classList.toggle("hidden", !showFacts);
  factsEl.innerHTML = "";
  v.facts.forEach((fact, i) => {
    if (i) factsEl.append(" · ");
    factsEl.append(fact);
  });
}

// The reason chips and status picker under the Flagged checkbox. Chips are
// toggle buttons (aria-pressed), drawn once from FLAG_REASONS plus any code
// the current flag has that config no longer lists.
function chosenReasons() {
  return [...document.querySelectorAll("#notes-flag-reasons .reason-chip[aria-pressed='true']")].map(
    (b) => b.dataset.code,
  );
}

function renderReasonChips(selected) {
  const wrap = document.getElementById("notes-flag-reasons");
  wrap.innerHTML = "";
  const codes = [...Object.keys(FLAG_REASONS), ...selected.filter((c) => !(c in FLAG_REASONS))];
  for (const code of codes) {
    const info = reasonInfo(code);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reason-chip";
    b.style.setProperty("--pill-accent", `var(--ctp-${info.color})`);
    b.dataset.code = code;
    b.textContent = info.label;
    b.setAttribute("aria-pressed", selected.includes(code) ? "true" : "false");
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
      updateNotesSaveButton();
    });
    wrap.appendChild(b);
  }
}

function updateFlagDetailVisibility() {
  const flagged = document.getElementById("notes-modal-flagged").checked;
  document.getElementById("notes-flag-detail").classList.toggle("hidden", !flagged);
}

const statusSelect = document.getElementById("notes-flag-status");
for (const st of FLAG_STATUSES) statusSelect.add(new Option(FLAG_STATUS_LABELS[st] || st, st));

function notesFormState() {
  return JSON.stringify([
    document.getElementById("notes-modal-text").value.trim(),
    document.getElementById("notes-modal-flagged").checked,
    chosenReasons(),
    document.getElementById("notes-flag-status").value,
    document.getElementById("notes-modal-excluded").checked,
    document.getElementById("notes-modal-contact").value.trim(),
  ]);
}

// The inline note box grows with its text, from two lines up to a cap.
function growNoteInput() {
  const el = document.getElementById("notes-modal-text");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
}

// Save/Cancel show only once something's changed.
function updateNotesSaveButton() {
  const show = isNotesDirty();
  document.getElementById("notes-modal-save").classList.toggle("hidden", !show);
  document.getElementById("notes-modal-cancel").classList.toggle("hidden", !show);
}

// Fields from notesView (the summary's note box is filled by
// renderNotesSummary), then snapshot — so Cancel/reopening starts clean.
function fillNotesForm() {
  const v = notesView;
  document.getElementById("notes-modal-flagged").checked = !!v.flagged;
  renderReasonChips(v.flag_reasons || []);
  document.getElementById("notes-flag-status").value = v.flag_status || FLAG_STATUSES[FLAG_STATUSES.length - 1];
  document.getElementById("notes-flag-status-date").textContent = v.flag_status_date ? `since ${v.flag_status_date}` : "";
  updateFlagDetailVisibility();
  document.getElementById("notes-modal-excluded").checked = !!v.excluded;
  document.getElementById("notes-modal-contact").value = v.contact || "";
  const hint = document.getElementById("notes-modal-contact-hint");
  hint.innerHTML = "";
  if (!v.contact && v.providerContact) {
    hint.append("Provider's: ");
    hint.appendChild(contactNode(v.providerContact));
    const use = document.createElement("button");
    use.type = "button";
    use.className = "notes-hint-btn";
    use.textContent = "Use";
    use.addEventListener("click", () => {
      document.getElementById("notes-modal-contact").value = v.providerContact;
      hint.innerHTML = "";
      updateNotesSaveButton();
    });
    hint.append(" ");
    hint.appendChild(use);
  }
  notesSaved = notesFormState();
}

// Back to what's saved — Cancel, reopening, and after a save.
function resetNotesModal() {
  renderNotesSummary();
  fillNotesForm();
  updateNotesSaveButton();
  setNotesStatus("");
}

function isNotesDirty() {
  return notesSaved !== null && notesFormState() !== notesSaved;
}

function setNotesStatus(text) {
  document.getElementById("notes-modal-status").textContent = text;
}

function classNoteItem(n) {
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.className = "meta";
  const values = Object.values(n.values || {}).join(" / ") || "(all rows)";
  head.textContent = `${n.target} · ${values} → ${n.value}`;
  if (n.flag) head.appendChild(notesPill(n.flag, n.flag));
  li.appendChild(head);
  if (n.notes) {
    const text = document.createElement("div");
    text.textContent = n.notes;
    li.appendChild(text);
  }
  return li;
}

function sourceView(s, details) {
  const d = details || {};
  const id = s.source_id;
  return {
    note: s.markers.notes,
    flagged: s.markers.flagged,
    flag_reasons: s.markers.flag_reasons || [],
    flag_status: s.markers.flag_status || "",
    flag_status_date: s.markers.flag_status_date || "",
    has_contact: details ? !!(d.contact || d.provider_contact) : s.markers.has_contact,
    excluded: s.markers.excluded,
    status: pipelineSummary(s),
    sourceUrl: d.dataset_page_url || "",
    links: [[d.portal_url, "Portal ↗"]],
    metaHref: `/collection/?id=${encodeURIComponent(id)}`,
    metaText: "Metadata ↗",
    contact: d.contact || "",
    providerContact: d.provider_contact || "",
    facts: details ? sourceFacts(d) : [],
  };
}

function providerView(p) {
  return {
    note: p.notes,
    flagged: true,
    flag_reasons: p.flag_reasons || [],
    flag_status: p.flag_status || "",
    flag_status_date: p.flag_status_date || "",
    has_contact: !!(p.contact || "").trim(),
    excluded: false,
    status: p.source_ids.length
      ? `Provider follow-up · ${p.source_ids.length} source${p.source_ids.length === 1 ? "" : "s"}`
      : "Provider follow-up · no source yet",
    sourceUrl: p.source_url || "",
    links: [[p.portal_url, "Portal ↗"]],
    metaHref: `/collection/?provider=${encodeURIComponent(p.provider_id)}`,
    metaText: "Checklist row ↗",
    contact: p.contact || "",
    providerContact: "",
    facts: [],
  };
}

async function openNotesModal(target) {
  notesTarget = target;
  const isSource = target.kind === "source";
  const path = document.getElementById("notes-modal-path");
  const link = document.getElementById("notes-modal-link");
  const classWrap = document.getElementById("notes-modal-class");
  const classList = document.getElementById("notes-modal-class-list");
  document.getElementById("notes-modal-excluded-wrap").classList.toggle("hidden", !isSource);
  classWrap.classList.add("hidden");
  classList.innerHTML = "";
  link.textContent = "";

  if (isSource) {
    const s = target.source;
    document.getElementById("notes-modal-title").textContent = s.source_id;
    path.textContent = "Loading…";
    notesView = sourceView(s, null);
  } else {
    const p = target.provider;
    document.getElementById("notes-modal-title").textContent = p.name || p.provider_id;
    path.textContent = `${p.provider_id} · sources/checklist.csv`;
    notesView = providerView(p);
  }
  setNotesStatus("");
  resetNotesModal();
  document.getElementById("notes-modal").classList.remove("hidden");
  growNoteInput(); // needs the panel visible to measure
  if (!isSource) return;

  // Fresh, not the table's copy — another tab may have edited it since.
  const s = target.source;
  let data;
  try {
    const res = await fetch(`/api/source_notes/${encodeURIComponent(s.source_id)}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    path.textContent = `Couldn't load details: ${e.message}`;
    return;
  }
  if (notesTarget !== target) return; // closed or switched while loading
  path.textContent = data.path;
  s.markers = { ...s.markers, ...flagFields(data), notes: data.notes, excluded: data.excluded };
  notesView = sourceView(s, data.details);
  // Anything typed while this loaded is kept rather than overwritten.
  if (isNotesDirty()) {
    const typed = document.getElementById("notes-modal-text").value;
    renderNotesSummary();
    document.getElementById("notes-modal-text").value = typed;
    growNoteInput();
  } else {
    renderNotesSummary();
    fillNotesForm();
  }
  if (data.class_notes && data.class_notes.length) {
    for (const n of data.class_notes) classList.appendChild(classNoteItem(n));
    classWrap.classList.remove("hidden");
    link.href = `/classification/review.html?id=${encodeURIComponent(s.source_id)}`;
    link.textContent = "Open in Classify ↗";
  }
}

function flagFields(d) {
  return {
    flagged: d.flagged,
    flag_reasons: d.flag_reasons || [],
    flag_status: d.flag_status || "",
    flag_status_date: d.flag_status_date || "",
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function saveNotesModal() {
  if (!notesTarget || !isNotesDirty()) return;
  const notes = document.getElementById("notes-modal-text").value.trim();
  const flagged = document.getElementById("notes-modal-flagged").checked;
  const flag = flagged
    ? { flagged, flag_reasons: chosenReasons(), flag_status: document.getElementById("notes-flag-status").value }
    : { flagged };
  const excluded = document.getElementById("notes-modal-excluded").checked;
  const contact = document.getElementById("notes-modal-contact").value.trim();
  setNotesStatus("Saving…");
  let message = "Saved ✓";
  try {
    if (notesTarget.kind === "source") {
      const s = notesTarget.source;
      if (excluded !== s.markers.excluded) message = "Saved ✓ — takes effect on the next pipeline run";
      const saved = await postJson(`/api/source_notes/${encodeURIComponent(s.source_id)}`, {
        notes, ...flag, excluded, contact,
      });
      const hasContact = !!(contact || notesView.providerContact);
      s.markers = { ...s.markers, ...flagFields(saved), notes: saved.notes, excluded: saved.excluded, has_contact: hasContact };
      notesView = { ...notesView, ...flagFields(saved), note: saved.notes, excluded: saved.excluded, contact, has_contact: hasContact, status: pipelineSummary(s) };
    } else {
      const p = notesTarget.provider;
      await postJson("/collection/api/note", { row_index: p.row_index, notes });
      const savedFlag = await postJson("/collection/api/flag", { row_index: p.row_index, ...flag });
      Object.assign(p, flagFields(savedFlag));
      if (contact !== (p.contact || "")) {
        await postJson("/collection/api/contact", { row_index: p.row_index, contact });
      }
      p.notes = notes;
      p.contact = contact;
      p.has_contact = !!contact;
      if (!flagged) {
        flaggedProviders = flaggedProviders.filter((x) => x !== p);
        message = "Saved ✓ — unflagged, so it'll leave this list";
      }
      notesView = { ...notesView, ...flagFields(savedFlag), note: notes, contact, has_contact: !!contact };
    }
  } catch (e) {
    setNotesStatus(`Failed to save: ${e.message}`);
    return;
  }
  resetNotesModal();
  setNotesStatus(message);
  render();
}

function closeNotesModal() {
  document.getElementById("notes-modal").classList.add("hidden");
  notesTarget = null;
}

document.getElementById("notes-modal-cancel").addEventListener("click", resetNotesModal);
document.getElementById("notes-modal-text").addEventListener("input", () => {
  growNoteInput();
  updateNotesSaveButton();
});
for (const id of ["notes-modal-contact", "notes-modal-flagged", "notes-modal-excluded", "notes-flag-status"]) {
  document.getElementById(id).addEventListener("input", updateNotesSaveButton);
}
document.getElementById("notes-modal-flagged").addEventListener("input", updateFlagDetailVisibility);
document.getElementById("notes-modal-save").addEventListener("click", saveNotesModal);
document.getElementById("notes-modal-close").addEventListener("click", closeNotesModal);
// A click outside the panel closes it only when nothing's unsaved, so a
// stray click can't throw away a half-written note (× still always closes).
document.getElementById("notes-modal").addEventListener("click", (e) => {
  if (e.target.id !== "notes-modal") return;
  if (isNotesDirty()) {
    setNotesStatus("Unsaved changes — Save, or × to discard");
    return;
  }
  closeNotesModal();
});
document.addEventListener("keydown", (e) => {
  if (!notesTarget) return;
  if (e.key === "Escape" && !isNotesDirty()) closeNotesModal();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveNotesModal();
});

// A flagged checklist.csv row, shown only under the Flagged filter — most
// have no source yet, so there are no stage statuses to show.
function renderProviderRow(p) {
  const tr = document.createElement("tr");
  tr.className = "provider-row";

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  const name = document.createElement("div");
  name.className = "provider-name";
  name.textContent = p.name || p.provider_id;
  const sub = document.createElement("div");
  sub.className = "meta";
  sub.textContent = p.source_ids.length
    ? `provider · ${p.source_ids.length} source${p.source_ids.length === 1 ? "" : "s"}`
    : "provider · no source yet";
  nameTd.append(name, sub);
  tr.appendChild(nameTd);

  const rest = document.createElement("td");
  rest.colSpan = 7;
  rest.className = "group-boundary provider-rest";
  const text = document.createElement("span");
  text.className = "meta";
  text.textContent = p.notes || "Provider-level follow-up";
  const link = document.createElement("a");
  link.href = `/collection/?provider=${encodeURIComponent(p.provider_id)}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.className = "notes-link";
  link.textContent = "Collect ↗";
  rest.append(link, text);
  tr.appendChild(rest);

  const markers = { ...flagFields(p), notes: p.notes, flagged: true, has_contact: p.has_contact };
  const open = () => openNotesModal({ kind: "provider", provider: p });
  tr.appendChild(notesCell(markers, open));
  tr.appendChild(followUpCell(markers, open));
  return tr;
}

function renderRow(s) {
  const tr = document.createElement("tr");
  tr.appendChild(nameCell(s.source_id));

  // collection/ — metadata opens a read-only preview modal (see
  // yamlPreviewCell); raw is just a badge for whether the file showed up on
  // disk, no tool to click into.
  tr.appendChild(yamlPreviewCell(s.collection.metadata, s.source_id, "metadata", true));
  tr.appendChild(rawInfoCell(s.collection.raw, s.source_id, s.collection.raw_filename));

  // tools/ — column_map.yaml and classification_map.yaml get the same
  // read-only preview treatment as metadata.yaml (see yamlPreviewCell);
  // preprocessing sits between them (mechanical, no review UI, but
  // classification can't run without it — see server.py).
  tr.appendChild(yamlPreviewCell(s.tools.column_mapping, s.source_id, "column_map", true));
  tr.appendChild(pipelineCell(s.tools.preprocessing, s.source_id, "preprocessing"));
  tr.appendChild(yamlPreviewCell(s.tools.classification, s.source_id, "classification_map"));

  // pipeline/ — mechanical, no review UI to link into yet.
  tr.appendChild(pipelineCell(s.pipeline.processing, s.source_id, "processing", true));
  tr.appendChild(plainCell(s.pipeline.validation));

  const open = () => openNotesModal({ kind: "source", source: s });
  tr.appendChild(notesCell(s.markers, open));
  tr.appendChild(followUpCell(s.markers, open));

  return tr;
}

// table-scroll gets a real fixed height (not just max-height) so it fills
// the viewport below the nav bar from first paint, before any rows have
// loaded — matching collection/app.js's updateHeaderOffset, including the
// same fix for the same bug: measuring via table-scroll's own
// boundingClientRect rather than summing nav's offsetHeight, since the
// latter misses the CSS margin between nav and table-scroll. The footer
// below is a fixed height in CSS (see style.css), not measured, so it
// doesn't need accounting for here beyond the literal 3rem already baked
// into the max-height calc there.
function updateStickyOffsets() {
  const nav = document.querySelector(".geomerge-nav");
  const tableScroll = document.querySelector(".table-scroll");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
  if (tableScroll) {
    const topOffset = tableScroll.getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty("--header-height", `${topOffset}px`);
  }
}
window.addEventListener("resize", updateStickyOffsets);
updateStickyOffsets();

let sources = null; // null until statuses have loaded
let flaggedProviders = []; // flagged checklist.csv rows, for the Flagged filter

function render() {
  const filterMode = document.getElementById("filter-mode").value;
  let visible = sources;
  let providerRows = [];
  if (filterMode === "complete") {
    visible = sources.filter(isRowComplete);
  } else if (filterMode === "incomplete") {
    visible = sources.filter((s) => !isRowComplete(s));
  } else if (filterMode === "flagged") {
    const match = flagMatcher(document.getElementById("flag-filter").value);
    visible = sources.filter((s) => s.markers.flagged && match(s.markers));
    providerRows = flaggedProviders.filter(match);
  } else if (filterMode === "excluded") {
    visible = sources.filter((s) => s.markers.excluded);
  }

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of visible) {
    body.appendChild(renderRow(s));
  }
  for (const p of providerRows) {
    body.appendChild(renderProviderRow(p));
  }

  // About this table's own rows (every stage, not just one), not the
  // provider-checklist-level "X checked, Y found" stat collection's page
  // already covers — same completeness rule as the Complete/Incomplete
  // filter above, independent of whatever filter is currently selected.
  const completeCount = sources.filter(isRowComplete).length;
  const flaggedCount = sources.filter((s) => s.markers.flagged).length;
  const excludedCount = sources.filter((s) => s.markers.excluded).length;
  const flags = [...sources.filter((s) => s.markers.flagged).map((s) => s.markers), ...flaggedProviders];
  const byStatus = FLAG_STATUSES.map((st) => {
    const n = flags.filter((m) => m.flag_status === st).length;
    const find = st === "contact" ? flags.filter(needsContactFound).length : 0;
    return `${n} ${st}${find ? ` (${find} to find)` : ""}`;
  }).join(" / ");
  document.getElementById("summary").textContent =
    `${completeCount} / ${sources.length} sources complete · ${flaggedCount} flagged · ` +
    `${flaggedProviders.length} flagged providers · follow-ups: ${byStatus} · ${excludedCount} excluded`;
}

async function load() {
  sources = null;
  const providersPromise = fetch("/api/flagged_providers")
    .then((res) => res.json())
    .catch(() => []);
  await loadStatusTable({
    footerId: "summary",
    nameCell,
    statusColumns: 9, boundaryColumns: [0, 2, 5, 7],
    onLoaded: async (data) => {
      sources = data;
      // Same field a source row gets from server.py, so the filter, footer
      // and Follow-up cell treat both kinds of row alike.
      flaggedProviders = (await providersPromise).map((p) => ({ ...p, has_contact: !!(p.contact || "").trim() }));
      render();
    },
  });
}

document.getElementById("refresh-btn").addEventListener("click", load);

// The Flagged filter's own narrowing select: "status:waiting",
// "reason:data_too_old", "reason:" (no reason yet) or "" (all).
function flagMatcher(value) {
  if (!value) return () => true;
  const [kind, arg] = value.split(":");
  if (kind === "status" && arg === "find-contact") return needsContactFound;
  if (kind === "status") return (m) => m.flag_status === arg;
  if (kind === "reason") return (m) => (arg ? (m.flag_reasons || []).includes(arg) : !(m.flag_reasons || []).length);
  return () => true;
}

function fillFlagFilter() {
  const sel = document.getElementById("flag-filter");
  sel.add(new Option("All flags", ""));
  const group = (label, options) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [text, value] of options) g.appendChild(new Option(text, value));
    sel.appendChild(g);
  };
  group("Follow-up", [
    ...FLAG_STATUSES.map((st) => [FLAG_STATUS_LABELS[st] || st, `status:${st}`]),
    ["Find contact (no contact yet)", "status:find-contact"],
  ]);
  group("Reason", [
    ...Object.entries(FLAG_REASONS).map(([code, info]) => [info.label, `reason:${code}`]),
    ["No reason yet", "reason:"],
  ]);
}
fillFlagFilter();

const filterSelect = document.getElementById("filter-mode");
const flagFilterSelect = document.getElementById("flag-filter");
function updateFlagFilterVisibility() {
  flagFilterSelect.classList.toggle("hidden", filterSelect.value !== "flagged");
}
try {
  const savedFilter = localStorage.getItem("home-filter-mode");
  if (savedFilter) filterSelect.value = savedFilter;
  const savedFlagFilter = localStorage.getItem("home-flag-filter");
  if (savedFlagFilter && [...flagFilterSelect.options].some((o) => o.value === savedFlagFilter)) {
    flagFilterSelect.value = savedFlagFilter;
  }
} catch {}
updateFlagFilterVisibility();
filterSelect.addEventListener("change", () => {
  try { localStorage.setItem("home-filter-mode", filterSelect.value); } catch {}
  updateFlagFilterVisibility();
  if (sources) render();
});
flagFilterSelect.addEventListener("change", () => {
  try { localStorage.setItem("home-flag-filter", flagFilterSelect.value); } catch {}
  if (sources) render();
});

load();
