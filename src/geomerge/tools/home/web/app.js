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

// Raw has no editor of its own, but "complete" means a file's actually sat
// down on disk somewhere — worth a click to confirm exactly where without
// digging through data/raw/ by hand. "missing" stays a plain, inert badge
// since there's nothing to show.
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
// stacked: opened from the notes popout — sits above it. Edit always opens
// a new tab, so you can work through several without losing this page.
async function openYamlModal(kind, sourceId, { stacked = false } = {}) {
  const preview = YAML_PREVIEWS[kind];
  document.getElementById("yaml-modal").classList.toggle("modal-stacked", stacked);
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

// --- Notes column + popout ---------------------------------------------------
// One note, flag and exclude switch per source (metadata.yaml — see
// helpers/source_notes.py), shared by every stage. The cell shows pills only;
// the full text is on hover and in the popout, which is also where they're
// edited. Provider-level follow-ups (flagged checklist.csv rows, usually with
// no source yet) get the same popout, minus the exclude switch.

// The Status column: a flag's status, or nothing. Clicking it opens a small
// menu of FLAG_STATUSES; picking one saves straight away (onPick).
function followUpCell(markers, onPick) {
  const td = document.createElement("td");
  td.className = "followup-cell";
  if (!markers.flagged) return td;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-trigger";
  btn.appendChild(statusPill(markers));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openStatusMenu(btn, markers.flag_status, onPick);
  });
  td.appendChild(btn);
  return td;
}

function openStatusMenu(anchor, current, onPick) {
  openPillMenu(anchor, statusOptions(current), async (st) => {
    if (st === current) return;
    try {
      await onPick(st);
    } catch (err) {
      alert(`Failed to save status: ${err.message}`);
    }
    render();
  });
}

function notesCell(markers, onOpen) {
  const td = document.createElement("td");
  td.className = "notes-cell";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-trigger";
  const pills = [];
  if (markers.flagged) pills.push(...flagPills(markers));
  if (markers.excluded) pills.push(notesPill("excluded", "excluded"));
  if (markers.notes && !markers.flagged && !markers.excluded) pills.push(notesPill("note", "note"));
  // A flagged source's reasons already say what's wrong; its class notes
  // are still in the popout.
  if (markers.class_notes && !markers.flagged) pills.push(notesPill(`${markers.class_notes} class`, "class"));
  btn.append(...compactPills(pills));
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
let notesView = null; // what the summary shows: {label, note, flagged, flag_reasons, flag_status, flag_status_date, excluded, links, contact, providerContact, updated, metaView, metaHref, metaLabel}
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

function renderNotesSummary() {
  const v = notesView;
  const noteInput = document.getElementById("notes-modal-text");
  noteInput.value = v.note || "";
  noteInput.placeholder = "Add a note…";
  growNoteInput();

  // External links (data page, portal), then the internal metadata editor
  // on its own row. The full URL is on hover.
  const linksEl = document.getElementById("notes-sum-links");
  linksEl.innerHTML = "";
  for (const [href, text] of v.links) {
    if (!href) continue;
    if (linksEl.childNodes.length) linksEl.append(" · ");
    const a = externalLink(href, `${text} ↗`);
    a.title = href;
    linksEl.appendChild(a);
  }
  if (!linksEl.childNodes.length) {
    const missing = document.createElement("span");
    missing.className = "notes-missing";
    missing.textContent = "None recorded";
    linksEl.appendChild(missing);
  }

  const metaEl = document.getElementById("notes-sum-meta");
  document.getElementById("notes-sum-meta-label").textContent = v.metaLabel;
  metaEl.innerHTML = "";
  // A source's metadata.yaml opens in the read-only YAML modal (its Edit
  // goes to Collect in a new tab); a provider's checklist row has no file
  // of its own to show, so it links straight to Collect.
  if (v.metaView) {
    const view = document.createElement("button");
    view.type = "button";
    view.className = "notes-link-btn";
    view.textContent = "View";
    view.addEventListener("click", v.metaView);
    metaEl.appendChild(view);
  } else {
    const edit = externalLink(v.metaHref, "Edit ↗");
    metaEl.appendChild(edit);
  }

  const showUpdated = !!v.updated;
  document.getElementById("notes-sum-updated-label").classList.toggle("hidden", !showUpdated);
  const updatedEl = document.getElementById("notes-sum-updated");
  updatedEl.classList.toggle("hidden", !showUpdated);
  updatedEl.textContent = v.updated || "";
}

// The popout's flag editor (top of the panel) — /flag-editor.js.
const flagEditor = createFlagEditor(document.getElementById("notes-flag-editor"), {
  onChange: () => updateNotesSaveButton(),
  hasContact: () => !!(document.getElementById("notes-modal-contact").value.trim() || notesView?.providerContact),
});

function notesFormState() {
  return JSON.stringify([
    document.getElementById("notes-modal-text").value.trim(),
    flagEditor.get(),
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
  flagEditor.set(v);
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
    links: [[d.dataset_page_url, "Data"], [d.portal_url, "Portal"]],
    metaView: () => openYamlModal("metadata", id, { stacked: true }),
    metaLabel: "Metadata",
    contact: d.contact || "",
    providerContact: d.provider_contact || "",
    updated: d.source_updated_date || "",
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
    links: [[p.source_url, "Data"], [p.portal_url, "Portal"]],
    metaHref: `/collection/?provider=${encodeURIComponent(p.provider_id)}`,
    metaLabel: "Checklist",
    contact: p.contact || "",
    providerContact: "",
    updated: "",
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
  const flag = flagEditor.get();
  const flagged = flag.flagged;
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
      notesView = { ...notesView, ...flagFields(saved), note: saved.notes, excluded: saved.excluded, contact, has_contact: hasContact };
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
for (const id of ["notes-modal-contact", "notes-modal-excluded"]) {
  document.getElementById(id).addEventListener("input", updateNotesSaveButton);
}
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

// A flagged checklist.csv row, shown only under the Flagged view — a
// provider-level follow-up, usually with no source yet: Provider filled,
// Source and the stage columns blank.
function renderProviderRow(p) {
  const tr = document.createElement("tr");
  tr.className = "provider-row";
  tr.append(providerCell({ id: p.provider_id, name: p.name, province: p.province }), provinceCell(p.province));

  const src = document.createElement("td");
  src.className = "meta";
  src.textContent = p.source_ids.length ? `${p.source_ids.length} source${p.source_ids.length === 1 ? "" : "s"}` : "—";
  tr.appendChild(src);

  const rest = document.createElement("td");
  rest.colSpan = 6;
  rest.className = "group-boundary";
  tr.appendChild(rest);

  const markers = providerMarkers(p);
  const open = () => openNotesModal({ kind: "provider", provider: p });
  tr.appendChild(notesCell(markers, open));
  tr.appendChild(
    followUpCell(markers, async (flag_status) => {
      Object.assign(p, flagFields(await postJson("/collection/api/flag", { row_index: p.row_index, flag_status })));
    }),
  );
  return tr;
}

function providerMarkers(p) {
  return { ...flagFields(p), notes: p.notes, flagged: true, has_contact: p.has_contact, excluded: false };
}

function renderRow(s) {
  const tr = document.createElement("tr");
  tr.append(providerCell(s.provider), provinceCell(s.provider.province), sourceCell(s.source_id, s.provider.id, s.title));

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

  const open = () => openNotesModal({ kind: "source", source: s });
  tr.appendChild(notesCell(s.markers, open));
  tr.appendChild(
    followUpCell(s.markers, async (flag_status) => {
      const saved = await postJson(`/api/source_notes/${encodeURIComponent(s.source_id)}`, { flag_status });
      s.markers = { ...s.markers, ...flagFields(saved) };
    }),
  );

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
    visible = sources.filter((s) => s.markers.flagged);
    providerRows = flaggedProviders;
  } else if (filterMode === "excluded") {
    visible = sources.filter((s) => s.markers.excluded);
  }

  // Sources and provider rows filter/sort together (/table-filter.js).
  const items = tableFilter.apply([...visible, ...providerRows.map((p) => ({ ...p, kind: "provider", _p: p }))]);
  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const item of items) {
    body.appendChild(item.kind === "provider" ? renderProviderRow(item._p) : renderRow(item));
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
    `${flaggedProviders.length} flagged providers · status: ${byStatus} · ${excludedCount} excluded`;
}

async function load() {
  sources = null;
  const providersPromise = fetch("/api/flagged_providers")
    .then((res) => res.json())
    .catch(() => []);
  await loadStatusTable({
    footerId: "summary",
    nameCell: placeholderNameCells,
    statusColumns: 8, boundaryColumns: [0, 2, 5, 6],
    onLoaded: async (data) => {
      sources = data;
      // Same field a source row gets from server.py, so the filter, footer
      // and Follow-up cell treat both kinds of row alike.
      flaggedProviders = (await providersPromise).map((p) => ({ ...p, has_contact: !!(p.contact || "").trim() }));
      render();
    },
  });
}


// --- Filters -------------------------------------------------------------------
// View dropdown + column filters/sort/search, kept in the URL (/table-filter.js).
const isProvider = (r) => r.kind === "provider";
const markersOf = (r) => (isProvider(r) ? providerMarkers(r._p) : r.markers);
const STAGE_ORDER = ["complete", "needs_review", "not_complete", "partial", "stale", "not_started", "missing", "not_built", "not_applicable", "—"];
const stageColumn = (label, get) => ({
  label,
  values: (r) => [isProvider(r) ? "—" : get(r)],
  format: (v) => v.replace(/_/g, " "),
  order: STAGE_ORDER,
  sort: (r) => STAGE_ORDER.indexOf(isProvider(r) ? "—" : get(r)),
});

const tableFilter = createTableFilter({
  columns: {
    provider: {
      label: "Provider",
      filter: false,
      values: () => [],
      sort: (r) => (isProvider(r) ? r.name : r.provider.name || "").toLowerCase(),
    },
    province: {
      label: "Prov.",
      values: (r) => [(isProvider(r) ? r.province : r.provider.province) || "—"],
      sort: (r) => (isProvider(r) ? r.province : r.provider.province) || "",
    },
    source: { label: "Source", filter: false, values: () => [], sort: (r) => (isProvider(r) ? "" : (r.title || sourceLabel(r.source_id, r.provider.id)).toLowerCase()) },
    metadata: stageColumn("Metadata", (s) => s.collection.metadata),
    raw: stageColumn("Raw", (s) => s.collection.raw),
    map: stageColumn("Map", (s) => s.tools.column_mapping),
    preprocess: stageColumn("Preprocess", (s) => s.tools.preprocessing),
    classify: stageColumn("Classify", (s) => s.tools.classification),
    process: stageColumn("Process", (s) => s.pipeline.processing),
    notes: notesFilterColumn(markersOf),
    status: statusFilterColumn(markersOf),
  },
  search: (r) =>
    isProvider(r)
      ? [r.name, r.provider_id, r.province, r.notes, r.contact].join(" ")
      : [r.source_id, r.title, r.provider.name, r.provider.id, r.provider.province, r.markers.notes].join(" "),
  onChange: () => sources && render(),
});
for (const th of document.querySelectorAll("#rows th[data-col]")) tableFilter.attachHeader(th, th.dataset.col);
tableFilter.attachSearch(document.getElementById("table-search"));
tableFilter.attachSummary(document.getElementById("table-summary"));

const filterSelect = document.getElementById("filter-mode");
bindViewSelect(filterSelect, () => sources && render());

// Refresh statuses — in the filter bar.
const refreshBtn = document.createElement("button");
refreshBtn.type = "button";
refreshBtn.className = "refresh-btn";
refreshBtn.title = "Refresh status";
refreshBtn.textContent = "↻";
refreshBtn.addEventListener("click", load);
document.querySelector(".header-filters").appendChild(refreshBtn);

load();
