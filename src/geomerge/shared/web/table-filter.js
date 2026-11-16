// Column filters, sorting and search for a dashboard table — shared so every
// tab can filter the same way. Loaded via <script src="/table-filter.js">
// with /table-filter.css.
//
//   const tf = createTableFilter({
//     columns: {                       // filterable/sortable columns, by key
//       province: {
//         label: "Prov.",
//         values: (row) => [row.province],   // one or more values per row
//         format: (v) => v,                   // optional: value -> display text
//         group: (v) => "Status",             // optional: section in the menu;
//                                             // OR within a section, AND across
//         sort: (row) => row.province,        // optional: makes the header sortable
//         filter: true,                       // default true; false = sort only
//       },
//     },
//     search: (row) => `${row.name} ${row.url}`,  // optional haystack for the search box
//     onChange: render,                // re-render after any change
//   });
//   tf.attachHeader(th, "province");   // ▾ menu (and sort on the label)
//   tf.attachSearch(input);
//   tf.attachSummary(el);              // "Showing 23 of 217 · Prov.: ON · Clear"
//   visible = tf.apply(rows);          // filter + sort, then render
//
// State lives in the URL (f_<key>=a,b · q=text · sort=key or -key), via
// history.replaceState, so a link reopens the same view. Other URL params
// are left alone.

function createTableFilter({ columns, search = null, onChange = () => {} }) {
  const params = new URLSearchParams(location.search);
  const selected = {}; // key -> Set of values
  for (const key of Object.keys(columns)) {
    const raw = params.get(`f_${key}`);
    selected[key] = new Set(raw ? raw.split(",") : []);
  }
  let query = params.get("q") || "";
  let sortKey = null;
  let sortDir = 1;
  const rawSort = params.get("sort");
  if (rawSort) {
    sortDir = rawSort.startsWith("-") ? -1 : 1;
    sortKey = rawSort.replace(/^-/, "");
    if (!columns[sortKey]?.sort) sortKey = null;
  }

  let lastRows = [];
  let lastShown = 0;
  const headers = {}; // key -> th
  let summaryEl = null;
  let menu = null;

  const fmt = (key, v) => (columns[key].format ? columns[key].format(v) : v);
  const groupOf = (key, v) => (columns[key].group ? columns[key].group(v) : "");

  function writeUrl() {
    const p = new URLSearchParams(location.search);
    for (const key of Object.keys(columns)) {
      if (selected[key].size) p.set(`f_${key}`, [...selected[key]].join(","));
      else p.delete(`f_${key}`);
    }
    if (query) p.set("q", query);
    else p.delete("q");
    if (sortKey) p.set("sort", `${sortDir < 0 ? "-" : ""}${sortKey}`);
    else p.delete("sort");
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
  }

  function changed() {
    writeUrl();
    refreshHeaders();
    onChange();
  }

  // One column's selection: OR within a group, AND across groups.
  function matchesColumn(row, key) {
    const sel = selected[key];
    if (!sel.size) return true;
    const values = columns[key].values(row);
    const byGroup = {};
    for (const v of sel) (byGroup[groupOf(key, v)] ||= []).push(v);
    return Object.values(byGroup).every((vs) => vs.some((v) => values.includes(v)));
  }

  function matchesSearch(row) {
    if (!query || !search) return true;
    return search(row).toLowerCase().includes(query.toLowerCase());
  }

  function passes(row, exceptKey = null) {
    if (!matchesSearch(row)) return false;
    return Object.keys(columns).every((key) => key === exceptKey || matchesColumn(row, key));
  }

  function apply(rows) {
    lastRows = rows;
    let out = rows.filter((r) => passes(r));
    if (sortKey) {
      const val = columns[sortKey].sort;
      out = [...out].sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (x === y) return 0;
        if (x === "" || x == null) return 1; // blanks last either way
        if (y === "" || y == null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir;
      });
    }
    lastShown = out.length;
    renderSummary();
    return out;
  }

  // --- header menu --------------------------------------------------------
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }
  document.addEventListener("click", (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  function openMenu(key, anchor) {
    closeMenu();
    // Counts over the rows every *other* filter lets through, so they show
    // what picking each value would leave.
    const counts = new Map();
    for (const row of lastRows) {
      if (!passes(row, key)) continue;
      for (const v of new Set(columns[key].values(row))) counts.set(v, (counts.get(v) || 0) + 1);
    }
    for (const v of selected[key]) if (!counts.has(v)) counts.set(v, 0);
    const order = columns[key].order;
    const values = [...counts.keys()].sort((a, b) =>
      order ? order.indexOf(a) - order.indexOf(b) : String(fmt(key, a)).localeCompare(String(fmt(key, b))),
    );

    menu = document.createElement("div");
    menu.className = "tf-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    let currentGroup = null;
    for (const v of values) {
      const g = groupOf(key, v);
      if (g && g !== currentGroup) {
        const h = document.createElement("div");
        h.className = "tf-menu-group";
        h.textContent = g;
        menu.appendChild(h);
        currentGroup = g;
      }
      const label = document.createElement("label");
      label.className = "tf-menu-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected[key].has(v);
      cb.addEventListener("change", () => {
        if (cb.checked) selected[key].add(v);
        else selected[key].delete(v);
        changed();
      });
      const text = document.createElement("span");
      text.textContent = fmt(key, v);
      const count = document.createElement("span");
      count.className = "tf-count";
      count.textContent = counts.get(v);
      label.append(cb, text, count);
      menu.appendChild(label);
    }
    if (!values.length) {
      const empty = document.createElement("div");
      empty.className = "tf-menu-group";
      empty.textContent = "No values";
      menu.appendChild(empty);
    }
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tf-menu-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      selected[key].clear();
      closeMenu();
      changed();
    });
    menu.appendChild(clear);

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  }

  function attachHeader(th, key) {
    const col = columns[key];
    headers[key] = th;
    const text = th.textContent;
    th.textContent = "";
    th.classList.add("tf-th");
    const label = document.createElement(col.sort ? "button" : "span");
    label.className = "tf-label";
    label.textContent = text;
    if (col.sort) {
      label.type = "button";
      label.title = "Sort";
      label.addEventListener("click", () => {
        if (sortKey !== key) {
          sortKey = key;
          sortDir = 1;
        } else if (sortDir === 1) sortDir = -1;
        else sortKey = null;
        changed();
      });
    }
    th.appendChild(label);
    if (col.filter !== false) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tf-filter-btn";
      btn.textContent = "▾";
      btn.title = `Filter by ${text}`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menu) closeMenu();
        else openMenu(key, btn);
      });
      th.appendChild(btn);
    }
    refreshHeaders();
  }

  function refreshHeaders() {
    for (const [key, th] of Object.entries(headers)) {
      th.classList.toggle("tf-active", selected[key].size > 0);
      th.classList.toggle("tf-sorted-asc", sortKey === key && sortDir === 1);
      th.classList.toggle("tf-sorted-desc", sortKey === key && sortDir === -1);
    }
  }

  // --- search + summary ---------------------------------------------------
  function attachSearch(input) {
    input.value = query;
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query = input.value.trim();
        changed();
      }, 150);
    });
  }

  function attachSummary(el) {
    summaryEl = el;
    renderSummary();
  }

  function isActive() {
    return !!query || Object.values(selected).some((s) => s.size);
  }

  function clearAll() {
    for (const s of Object.values(selected)) s.clear();
    query = "";
    const input = document.querySelector(".tf-search");
    if (input) input.value = "";
    changed();
  }

  function renderSummary() {
    if (!summaryEl) return;
    summaryEl.innerHTML = "";
    if (!isActive()) return;
    const parts = [`Showing ${lastShown} of ${lastRows.length}`];
    if (query) parts.push(`“${query}”`);
    for (const [key, sel] of Object.entries(selected)) {
      if (sel.size) parts.push(`${columns[key].label || key}: ${[...sel].map((v) => fmt(key, v)).join(", ")}`);
    }
    summaryEl.append(parts.join(" · "), " · ");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tf-clear-all";
    clear.textContent = "Clear";
    clear.addEventListener("click", clearAll);
    summaryEl.appendChild(clear);
  }

  return { apply, attachHeader, attachSearch, attachSummary, clearAll, isActive };
}

// The top "View" dropdown — cross-column states each page defines (All /
// Incomplete / …). Kept in the URL as view=… (omitted for the first
// option), like the column filters. onChange re-renders.
function bindViewSelect(select, onChange) {
  const v = new URLSearchParams(location.search).get("view");
  if (v && [...select.options].some((o) => o.value === v)) select.value = v;
  select.addEventListener("change", () => {
    const p = new URLSearchParams(location.search);
    if (select.selectedIndex === 0) p.delete("view");
    else p.set("view", select.value);
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    onChange();
  });
}
