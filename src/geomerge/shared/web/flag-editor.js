// Flag pills, the pill menu and the flag editor, shared by Home (notes
// popout, Notes/Status columns) and Collect (provider modal, Notes column).
// A flag (helpers/source_notes.py) is: flagged + flag_reasons (codes from
// the project's flag_reasons config) + flag_status (FLAG_STATUSES).
//
// Loaded via <script src="/flag-editor.js"> with /flag-editor.css. Expects
// the page to define FLAG_REASONS ({code: {label, color}}, config order) and
// FLAG_STATUSES (["contact", ...]) first — both injected by the template.

const FLAG_STATUS_LABELS = { contact: "Contact", waiting: "Waiting", review: "Review" };

function notesPill(text, kind) {
  const span = document.createElement("span");
  span.className = `notes-pill notes-pill-${kind}`;
  span.textContent = text;
  return span;
}

// Unknown codes (since dropped from config) still show, as their raw code.
function reasonInfo(code) {
  return FLAG_REASONS[code] || { label: code.replace(/_/g, " "), color: "overlay1" };
}

function reasonPill(code) {
  const info = reasonInfo(code);
  const pill = notesPill(info.label, "reason");
  pill.style.setProperty("--pill-accent", `var(--ctp-${info.color})`);
  return pill;
}

// A flag's reasons, or a plain "flagged" until it has any.
function flagPills(markers) {
  const reasons = markers.flag_reasons || [];
  return reasons.length ? reasons.map(reasonPill) : [notesPill("flagged", "flagged")];
}

// One line of pills, so every table row stays the same height: the first
// `max`, then "+N" (click the cell to see them all).
function compactPills(pills, max = 1) {
  if (pills.length <= max) return pills;
  return [...pills.slice(0, max), notesPill(`+${pills.length - max}`, "more")];
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

// --- Pill menu ---------------------------------------------------------------
// A small menu of pills under `anchor` — options: [[value, pill, isCurrent]].
// Closes on pick, outside click, Escape or scroll.
let pillMenu = null;

function closePillMenu() {
  if (pillMenu) pillMenu.remove();
  pillMenu = null;
}

function openPillMenu(anchor, options, onPick) {
  closePillMenu();
  const menu = document.createElement("div");
  menu.className = "pill-menu";
  for (const [value, pill, isCurrent] of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pill-menu-item";
    item.appendChild(pill);
    if (isCurrent) item.setAttribute("aria-current", "true");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closePillMenu();
      onPick(value);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  pillMenu = menu;
}

document.addEventListener("click", closePillMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePillMenu();
});
window.addEventListener("scroll", closePillMenu, true);

function statusOptions(current) {
  return FLAG_STATUSES.map((st) => [st, notesPill(FLAG_STATUS_LABELS[st] || st, `status-${st}`), st === current]);
}

// --- Flag editor ---------------------------------------------------------------
// Fills `root` (a <dl>) with two rows: Flag (checkbox, reason pills with ×,
// a "+ reason" pill) and Status (a pill that opens the status menu; shown
// only while flagged). Edits stay in memory until the page saves get().
// hasContact() decides whether "contact" reads as "Find contact".
function createFlagEditor(root, { onChange = () => {}, hasContact = () => true } = {}) {
  root.classList.add("flag-editor");
  root.innerHTML = "";
  const id = `flag-editor-${Math.random().toString(36).slice(2, 8)}`;

  const flagDt = document.createElement("dt");
  const flagLabel = document.createElement("label");
  flagLabel.htmlFor = id;
  flagLabel.textContent = "Flag";
  flagDt.appendChild(flagLabel);
  const flagDd = document.createElement("dd");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = id;
  const pills = document.createElement("span");
  pills.className = "flag-editor-pills";
  flagDd.append(checkbox, pills);

  const statusDt = document.createElement("dt");
  statusDt.textContent = "Status";
  const statusDd = document.createElement("dd");
  root.append(flagDt, flagDd, statusDt, statusDd);

  const state = { reasons: [], status: "" };

  function changed() {
    render();
    onChange();
  }

  function removablePill(code) {
    const pill = reasonPill(code);
    pill.classList.add("notes-pill-removable");
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pill-x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => {
      state.reasons = state.reasons.filter((r) => r !== code);
      changed();
    });
    pill.appendChild(x);
    return pill;
  }

  function render() {
    const flagged = checkbox.checked;
    pills.innerHTML = "";
    statusDd.innerHTML = "";
    statusDt.classList.toggle("hidden", !flagged);
    statusDd.classList.toggle("hidden", !flagged);
    if (!flagged) return;

    pills.append(...state.reasons.map(removablePill));
    const remaining = Object.keys(FLAG_REASONS).filter((c) => !state.reasons.includes(c));
    if (remaining.length) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "notes-pill notes-pill-add";
      add.textContent = "+ reason";
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        openPillMenu(add, remaining.map((c) => [c, reasonPill(c), false]), (code) => {
          state.reasons = [...state.reasons, code];
          changed();
        });
      });
      pills.appendChild(add);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "flag-editor-status";
    btn.appendChild(statusPill({ flag_status: state.status, has_contact: hasContact() }));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPillMenu(btn, statusOptions(state.status), (st) => {
        state.status = st;
        changed();
      });
    });
    statusDd.appendChild(btn);
  }

  checkbox.addEventListener("input", changed);

  return {
    set({ flagged = false, flag_reasons = [], flag_status = "" } = {}) {
      checkbox.checked = !!flagged;
      state.reasons = [...flag_reasons];
      state.status = flag_status || FLAG_STATUSES[FLAG_STATUSES.length - 1];
      render();
    },
    // What a save posts: {flagged} alone when unflagged.
    get() {
      return checkbox.checked
        ? { flagged: true, flag_reasons: [...state.reasons], flag_status: state.status }
        : { flagged: false };
    },
    render,
  };
}

// --- Flagged filter ------------------------------------------------------------
// The narrowing select next to a page's "Flagged" filter: "status:waiting",
// "status:find-contact", "reason:<code>" or "reason:" (none yet).
function fillFlagFilter(sel) {
  sel.add(new Option("All flags", ""));
  const group = (label, options) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [text, value] of options) g.appendChild(new Option(text, value));
    sel.appendChild(g);
  };
  group("Status", [
    ...FLAG_STATUSES.map((st) => [FLAG_STATUS_LABELS[st] || st, `status:${st}`]),
    ["Find contact (no contact yet)", "status:find-contact"],
  ]);
  group("Reason", [
    ...Object.entries(FLAG_REASONS).map(([code, info]) => [info.label, `reason:${code}`]),
    ["No reason yet", "reason:"],
  ]);
}

function flagMatcher(value) {
  if (!value) return () => true;
  const [kind, arg] = value.split(":");
  if (kind === "status" && arg === "find-contact") return needsContactFound;
  if (kind === "status") return (m) => m.flag_status === arg;
  if (kind === "reason") return (m) => (arg ? (m.flag_reasons || []).includes(arg) : !(m.flag_reasons || []).length);
  return () => true;
}

// --- Table-filter columns ------------------------------------------------------
// Column specs for /table-filter.js built from a row's flag markers
// (markersOf(row) -> {flagged, notes, flag_status, flag_reasons,
// has_contact, excluded}). notesFilterColumn's menu has a Notes section
// (flagged / note / none, plus excluded where the page has it), a Reason
// section, and — with status: true, for a page without its own Status
// column — a Status section.
function flagStatusValue(m) {
  return needsContactFound(m) ? "status:find-contact" : `status:${m.flag_status}`;
}

function flagFilterLabel(v) {
  const [kind, arg] = v.split(":");
  if (kind === "notes") {
    return { flagged: "Flagged", note: "Note only", none: "No note or flag", excluded: "Excluded" }[arg] || arg;
  }
  if (kind === "status") {
    if (arg === "none") return "—";
    return arg === "find-contact" ? "Find contact" : FLAG_STATUS_LABELS[arg] || arg;
  }
  return arg ? reasonInfo(arg).label : "No reason yet";
}

const FLAG_STATUS_ORDER = () => [...FLAG_STATUSES.map((s) => `status:${s}`), "status:find-contact", "status:none"];

function notesFilterColumn(markersOf, { status = false, label = "Notes" } = {}) {
  return {
    label,
    values: (row) => {
      const m = markersOf(row);
      const out = [];
      if (m.excluded) out.push("notes:excluded");
      if (!m.flagged) {
        out.push(m.notes ? "notes:note" : m.excluded ? null : "notes:none");
        return out.filter(Boolean);
      }
      out.push("notes:flagged");
      if (status) out.push(flagStatusValue(m));
      const reasons = m.flag_reasons || [];
      out.push(...(reasons.length ? reasons.map((r) => `reason:${r}`) : ["reason:"]));
      return out;
    },
    format: flagFilterLabel,
    group: (v) => ({ notes: "Notes", status: "Status", reason: "Reason" })[v.split(":")[0]],
    order: [
      "notes:flagged", "notes:note", "notes:none", "notes:excluded",
      ...FLAG_STATUS_ORDER(),
      ...Object.keys(FLAG_REASONS).map((c) => `reason:${c}`), "reason:",
    ],
    sort: (row) => {
      const m = markersOf(row);
      return m.flagged ? 0 : m.notes ? 1 : 2;
    },
  };
}

function statusFilterColumn(markersOf) {
  const order = FLAG_STATUS_ORDER();
  const value = (row) => {
    const m = markersOf(row);
    return m.flagged ? flagStatusValue(m) : "status:none";
  };
  return { label: "Status", values: (row) => [value(row)], format: flagFilterLabel, order, sort: (row) => order.indexOf(value(row)) };
}
