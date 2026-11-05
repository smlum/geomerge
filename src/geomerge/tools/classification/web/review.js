const params = new URLSearchParams(location.search);
const sourceId = params.get("id");

let appConfig = {
  mock: true, maps_api_key: null, street_view_enabled: false, n_samples: 3,
  not_included_value: "not_included", ignored_value: "ignored",
};
const sampleCache = new Map(); // key -> { points: [...], spare: [...] }
let modalEl = null;
let activeTarget = null;
let allTargetNames = [];
let valueLabels = {}; // column -> raw value -> {label, basis, notes}, from the source's value_labels.yaml
let dataDictionaryUrl = "";
let sourceFlagged = false;
const visitedTargets = new Set(); // tabs opened on this page load -- see saveVisitedTargets()

function cacheKey(target, values) {
  return `${target}::${JSON.stringify(values)}`;
}

function panoLink(p) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}&heading=${p.heading}`;
}

// Maps Embed API — a plain <iframe src>, not the Maps JavaScript API. No
// script to load, no panorama object lifecycle; switching points is just
// changing the iframe's src. Per Google's published pricing this usage is
// unmetered (unlike the JS API's per-load Dynamic Street View billing) —
// worth confirming current pricing before relying on that, but either way
// it needs "Maps Embed API" enabled on the key, not "Maps JavaScript API".
function embedUrl(p) {
  const qs = new URLSearchParams({
    key: appConfig.maps_api_key,
    location: `${p.lat},${p.lng}`,
    heading: String(p.heading),
    pitch: "0",
    fov: "90",
  });
  return `https://www.google.com/maps/embed/v1/streetview?${qs.toString()}`;
}

async function fetchSamplePoints(target, values, fresh) {
  const res = await fetch(`api/sample_points/${encodeURIComponent(sourceId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, values, fresh }),
  });
  const data = await res.json();
  return { points: data.points || [], spare: data.spare_points || [] };
}

// One request per group per page load; every sample's map draws from the same
// promise. Failures resolve to null so a map just goes without its network.
const networkCache = new Map(); // key -> Promise<{n_features, geometry} | null>

function fetchNetwork(target, values) {
  const key = cacheKey(target, values);
  if (!networkCache.has(key)) {
    networkCache.set(key, fetch(`api/network/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, values }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null));
  }
  return networkCache.get(key);
}

// --- Inspect modal ----------------------------------------------------------
// A single shared modal, built once and reused for every group — decouples
// the viewer from the table entirely (always centered, never off-screen to
// the right of a wide table), unlike the previous per-row inline panel.

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement("div");
  modalEl.className = "sv-modal hidden";
  modalEl.innerHTML = `
    <div class="sv-modal-backdrop"></div>
    <div class="sv-modal-content">
      <div class="sv-modal-header">
        <div id="sv-modal-title" class="sv-modal-title"></div>
        <button id="sv-modal-close" class="sv-modal-close" aria-label="Close">&times;</button>
      </div>
      <div id="sv-modal-body" class="sv-modal-body"></div>
    </div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector(".sv-modal-backdrop").addEventListener("click", closeModal);
  modalEl.querySelector("#sv-modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  return modalEl;
}

function closeModal() {
  if (modalEl) modalEl.classList.add("hidden");
}

// A sampled point's own row data (see geo_sampling.py's sample_points()) —
// not just the columns the current target happens to group by, so
// source_status can surface a proposed/not-yet-built segment right where the
// image is, while source_install_date can add useful context too.
function renderSampleValues(point) {
  const dl = document.createElement("dl");
  dl.className = "sv-sample-values";
  for (const [col, val] of Object.entries(point.values || {})) {
    const dt = document.createElement("dt");
    dt.textContent = col;
    const dd = document.createElement("dd");
    dd.textContent = val === "" ? "(blank)" : val;
    dl.append(dt, dd);
  }
  return dl;
}

function renderSampleMap(point, networkPromise) {
  const wrap = document.createElement("div");
  wrap.className = "sv-map-wrap";
  const mapEl = document.createElement("div");
  mapEl.className = "sv-point-map";
  const zoomBtn = document.createElement("button");
  zoomBtn.type = "button";
  zoomBtn.className = "sv-map-zoom hidden";
  const legend = document.createElement("div");
  legend.className = "meta sv-map-legend";
  legend.textContent = "Loading network…";
  wrap.append(mapEl, zoomBtn, legend);

  requestAnimationFrame(() => {
    if (!window.maplibregl) {
      mapEl.textContent = "Map unavailable — MapLibre did not load.";
      return;
    }

    const map = new maplibregl.Map({
      container: mapEl,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [point.lng, point.lat],
      zoom: 15,
      interactive: true,
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("sample-segment", {
        type: "geojson",
        data: { type: "Feature", geometry: point.segment, properties: {} },
      });
      const segmentLayer = {
        id: "sample-segment",
        type: "line",
        source: "sample-segment",
        paint: { "line-color": "#8839ef", "line-width": 5, "line-opacity": 0.85 },
      };
      const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol");
      map.addLayer(segmentLayer, firstSymbolLayer?.id);
      map.addSource("sample-point", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [point.lng, point.lat] },
          properties: {},
        },
      });
      map.addLayer({
        id: "sample-point",
        type: "circle",
        source: "sample-point",
        paint: {
          "circle-radius": 5,
          "circle-color": "#fe640b",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      const boundsOf = (geometry) => {
        const bounds = new maplibregl.LngLatBounds();
        const extendBounds = (coordinates) => {
          if (typeof coordinates[0] === "number") {
            bounds.extend(coordinates);
          } else {
            coordinates.forEach(extendBounds);
          }
        };
        extendBounds(geometry.coordinates);
        bounds.extend([point.lng, point.lat]);
        return bounds;
      };
      const segmentBounds = boundsOf(point.segment);
      map.fitBounds(segmentBounds, { padding: 18, maxZoom: 17, duration: 0 });

      networkPromise.then((network) => {
        if (!network || !network.geometry) {
          legend.textContent = "Network unavailable — showing this segment only.";
          return;
        }
        map.addSource("sample-network", {
          type: "geojson",
          data: { type: "Feature", geometry: network.geometry, properties: {} },
        });
        map.addLayer({
          id: "sample-network",
          type: "line",
          source: "sample-network",
          paint: { "line-color": "#1e66f5", "line-width": 2, "line-opacity": 0.7 },
        }, "sample-segment");

        const networkBounds = boundsOf(network.geometry);
        let showingNetwork = true;
        const showView = () => {
          map.fitBounds(showingNetwork ? networkBounds : segmentBounds, { padding: 18, maxZoom: 17, duration: 0 });
          zoomBtn.textContent = showingNetwork ? "Zoom to segment" : "Show network";
        };
        zoomBtn.addEventListener("click", () => {
          showingNetwork = !showingNetwork;
          showView();
        });
        zoomBtn.classList.remove("hidden");
        showView();

        legend.innerHTML = "";
        const key = (className, text) => {
          const span = document.createElement("span");
          span.className = className;
          span.textContent = text;
          return span;
        };
        legend.append(
          key("sv-key-network", `Blue: all ${network.n_features.toLocaleString()} features with these values`),
          " · ",
          key("sv-key-segment", "Purple: this feature"),
          " · ",
          key("sv-key-point", "Orange: this sample"),
        );
      });
    });
  });

  return wrap;
}

// The per-sample values + map — shared by both mock and live rendering
// below, and re-rendered as a pair whenever the displayed sample changes.
function renderSampleDetail(point, networkPromise) {
  const wrap = document.createElement("div");
  wrap.className = "sv-sample-detail";
  wrap.append(renderSampleValues(point), renderSampleMap(point, networkPromise));
  return wrap;
}

function renderPoints(container, points, onRegenerate, networkPromise) {
  container.innerHTML = "";
  if (!points.length) {
    container.textContent = "No sample points (no matching geometry).";
    return;
  }

  const mock = appConfig.mock || !appConfig.maps_api_key;
  let detailEl = null; // live mode only — appended after regenBtn below, so it renders underneath it

  if (mock) {
    for (const [i, p] of points.entries()) {
      const row = document.createElement("div");
      row.className = "sv-mock-row";
      const link = document.createElement("a");
      link.href = panoLink(p);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `Sample ${i + 1}`;
      row.appendChild(link);
      row.appendChild(renderSampleDetail(p, networkPromise));
      container.appendChild(row);
    }
  } else {
    let idx = 0;
    const iframe = document.createElement("iframe");
    iframe.className = "sv-embed";
    iframe.loading = "lazy";
    iframe.allow = "fullscreen";
    iframe.src = embedUrl(points[idx]);
    container.appendChild(iframe);

    const nav = document.createElement("div");
    nav.className = "sv-nav";
    const label = document.createElement("span");
    label.className = "meta";
    label.textContent = `Sample ${idx + 1} / ${points.length}`;
    nav.appendChild(label);
    if (points.length > 1) {
      const next = document.createElement("button");
      next.textContent = "Next sample →";
      next.addEventListener("click", () => {
        idx = (idx + 1) % points.length;
        iframe.src = embedUrl(points[idx]);
        label.textContent = `Sample ${idx + 1} / ${points.length}`;
        detailEl.replaceWith(renderSampleDetail(points[idx], networkPromise));
        detailEl = container.querySelector(".sv-sample-detail");
      });
      nav.appendChild(next);
    }
    container.appendChild(nav);
    detailEl = renderSampleDetail(points[idx], networkPromise);
  }

  const regenBtn = document.createElement("button");
  regenBtn.className = "sv-regen-btn";
  regenBtn.textContent = "↻ Regenerate points";
  regenBtn.title = "Get different sample points (e.g. if these are old or inconclusive)";
  regenBtn.addEventListener("click", onRegenerate);
  container.appendChild(regenBtn);

  // Below the regen button, not above — mock mode already has its own copy
  // of this per sample row (see the mock branch above), inline with each link.
  if (detailEl) container.appendChild(detailEl);
}

async function openStreetView(target, group) {
  const modal = ensureModal();
  const title = modal.querySelector("#sv-modal-title");
  const body = modal.querySelector("#sv-modal-body");

  title.textContent = Object.entries(group.values)
    .map(([k, v]) => `${k}: ${valueWithLabel(k, v)}`)
    .join("  ·  ");
  body.textContent = "Loading…";
  modal.classList.remove("hidden");

  const key = cacheKey(target, group.values);
  const networkPromise = fetchNetwork(target, group.values);

  async function regenerate() {
    let cached = sampleCache.get(key);
    const n = appConfig.n_samples;
    if (cached && cached.spare.length >= n) {
      cached.points = cached.spare.splice(0, n);
    } else {
      cached = await fetchSamplePoints(target, group.values, true);
      sampleCache.set(key, cached);
    }
    renderPoints(body, cached.points, regenerate, networkPromise);
  }

  let cached = sampleCache.get(key);
  if (!cached) {
    cached = await fetchSamplePoints(target, group.values, false);
    sampleCache.set(key, cached);
  }
  renderPoints(body, cached.points, regenerate, networkPromise);
}

// Generic display text — geomerge itself is domain-agnostic, and not every
// project classifying against a prior vintage will call it a year, so the
// bare noun is the default and the config-supplied label (e.g. "2024") is
// just parenthetical when present.
function priorYearLabel() {
  const label = appConfig.prior_year_dictionary_label;
  return label ? `Previous (${label})` : "Previous";
}

// --- Flag & note modal ------------------------------------------------------
// A modal rather than a popover anchored to the row, since .table-scroll's
// overflow would clip one. Closing it any way applies the edit to the row
// (nothing is written until a Save button), so a typed note can't be lost to
// a stray backdrop click.

let flagModalRef = null;

// --- Value label popup ----------------------------------------------------
// Says what a label is and where it came from, with a link to the dictionary.
// Opens on click, since it holds a link. One element on <body>, positioned by
// the clicked label, since .table-scroll's overflow would clip anything
// anchored inside the row.

const VALUE_LABEL_BASIS_TEXT = {
  data_dictionary: "Published by the data provider",
  inferred: "Inferred, not a published definition",
  translated: "Translated from the provider's wording",
};

let valueLabelPopup = null;
let valueLabelPopupAnchor = null;

function hideValueLabelPopup() {
  valueLabelPopup?.classList.add("hidden");
  valueLabelPopupAnchor?.setAttribute("aria-expanded", "false");
  valueLabelPopupAnchor = null;
}

function ensureValueLabelPopup() {
  if (valueLabelPopup) return valueLabelPopup;
  valueLabelPopup = document.createElement("div");
  valueLabelPopup.className = "value-label-popup hidden";
  document.body.appendChild(valueLabelPopup);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideValueLabelPopup();
  });
  document.addEventListener("click", (e) => {
    if (!valueLabelPopup.contains(e.target) && !e.target.closest(".value-label")) hideValueLabelPopup();
  });
  // Fixed position wouldn't follow the table as it scrolls. Capture phase
  // because scroll events don't bubble up from .table-scroll.
  window.addEventListener("scroll", (e) => {
    if (!valueLabelPopup.contains(e.target)) hideValueLabelPopup();
  }, true);
  return valueLabelPopup;
}

function showValueLabelPopup(anchor, column, value, entry) {
  const popup = ensureValueLabelPopup();
  hideValueLabelPopup();
  valueLabelPopupAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  popup.innerHTML = "";

  const addLine = (className, text) => {
    const line = document.createElement("div");
    line.className = className;
    line.textContent = text;
    popup.appendChild(line);
  };
  addLine("value-label-popup-key", `${column} = ${value}`);
  addLine("value-label-popup-label", entry.label);
  addLine("value-label-popup-basis", VALUE_LABEL_BASIS_TEXT[entry.basis] || "Source not recorded");
  if (entry.notes) addLine("value-label-popup-notes", entry.notes);

  // An inferred label didn't come from the dictionary, so linking one would
  // imply otherwise. Only http(s), since the URL is hand-entered metadata.
  if (entry.basis !== "inferred" && /^https?:\/\//i.test(dataDictionaryUrl)) {
    const link = document.createElement("a");
    link.href = dataDictionaryUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "View data dictionary ↗";
    popup.appendChild(link);
  }

  // Measured after filling; flips above the label if it'd run off the bottom.
  popup.classList.remove("hidden");
  const rect = anchor.getBoundingClientRect();
  const { width, height } = popup.getBoundingClientRect();
  const margin = 8;
  const below = rect.bottom + 4;
  const top = below + height + margin > window.innerHeight ? rect.top - height - 4 : below;
  popup.style.top = `${Math.max(margin, top)}px`;
  popup.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
}

function attachValueLabelPopup(labelEl, column, value, entry) {
  labelEl.setAttribute("aria-expanded", "false");
  labelEl.addEventListener("click", () => {
    if (valueLabelPopupAnchor === labelEl) hideValueLabelPopup();
    else showValueLabelPopup(labelEl, column, value, entry);
  });
}

function valueWithLabel(column, value) {
  const raw = value === "" ? "(blank)" : value;
  const label = valueLabels[column]?.[value]?.label;
  return label ? `${raw} (${label})` : raw;
}

function groupLabel(group) {
  return Object.entries(group.values).map(([k, v]) => valueWithLabel(k, v)).join(" · ");
}

function updateFlagButton(ref) {
  const { flagBtn, flag, notes } = ref;
  flagBtn.className = flag ? `flag-btn flag-${flag}` : "flag-btn";
  const label = flag || (notes ? "Note" : "Flag");
  flagBtn.textContent = flag && notes ? `${label} ✎` : label;
  flagBtn.title = notes;
}

function openFlagModal(ref) {
  flagModalRef = ref;
  document.getElementById("flag-modal-row").textContent = groupLabel(ref.group);
  document.getElementById("flag-modal-notes").value = ref.notes;

  const optionsEl = document.getElementById("flag-modal-options");
  optionsEl.innerHTML = "";
  for (const flag of ["", ...appConfig.review_flags]) {
    const label = document.createElement("label");
    label.className = "flag-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "flag-modal-flag";
    radio.value = flag;
    radio.checked = ref.flag === flag;
    label.append(radio, ` ${flag || "No flag"}`);
    optionsEl.appendChild(label);
  }

  document.getElementById("flag-modal").classList.remove("hidden");
}

function closeFlagModal() {
  if (!flagModalRef) return;
  const ref = flagModalRef;
  flagModalRef = null;
  ref.flag = document.querySelector('input[name="flag-modal-flag"]:checked')?.value ?? "";
  ref.notes = document.getElementById("flag-modal-notes").value.trim();
  document.getElementById("flag-modal").classList.add("hidden");
  updateFlagButton(ref);
}

// --- Group rows ---------------------------------------------------------

// Returns {tr, ref} — ref is what saveTarget() reads back at save time
// ({group, field, filterOutCheckbox, ignoreCheckbox, initialValue,
// initialMethod, flag, notes}), collected into targetRowRefs[target] by
// renderTargetSection below. No per-row save button/status text any more
// (see saveTarget) — a row just holds its live field state until one of
// the Save buttons reads it.
function renderGroupRow(target, group, columns, options, streetViewEnabled, showPriorYear) {
  const tr = document.createElement("tr");
  const notIncludedValue = appConfig.not_included_value;
  const ignoredValue = appConfig.ignored_value;
  const isFilteredOut = group.target === notIncludedValue;
  const isIgnored = group.target === ignoredValue;
  const initialValue = isFilteredOut || isIgnored ? "" : group.target || "";
  const initialMethod = group.method;

  for (const col of columns) {
    const td = document.createElement("td");
    td.className = "meta value-cell";
    const v = group.values[col] ?? "";
    td.textContent = v === "" ? "(blank)" : v;
    td.title = v;
    const labelEntry = valueLabels[col]?.[v];
    if (labelEntry) {
      const labelEl = document.createElement("button");
      labelEl.type = "button";
      labelEl.className = "value-label";
      labelEl.textContent = labelEntry.label;
      labelEl.title = ""; // keeps the cell's native tooltip from showing over the label
      if (labelEntry.notes) labelEl.classList.add("has-notes");
      attachValueLabelPopup(labelEl, col, v, labelEntry);
      td.appendChild(labelEl);
    }
    tr.appendChild(td);
  }

  const countTd = document.createElement("td");
  countTd.className = "meta";
  countTd.textContent = group.count;
  tr.appendChild(countTd);

  const targetTd = document.createElement("td");
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "target-field";

  let field;
  if (options) {
    field = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— choose —";
    field.appendChild(blank);
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      field.appendChild(o);
    }
  } else {
    field = document.createElement("input");
    field.type = "text";
    field.placeholder = "free text (no enum defined yet)";
  }
  field.value = initialValue;
  field.disabled = isFilteredOut || isIgnored;
  fieldWrap.appendChild(field);
  targetTd.appendChild(fieldWrap);

  // Two mutually-exclusive decisions, distinct from picking a real value:
  // "Filter out" drops the row from the dataset entirely (classify:apply
  // ORs this across every target — see NOT_INCLUDED); "Ignore" keeps the
  // row but leaves this one target blank for it (see IGNORED). Checking
  // one clears the other, and clearing (not just disabling) the field
  // avoids it reading as e.g. "multi_use_path AND filtered out" at once —
  // the greyed-out value was still visible even though save already
  // ignored it in that case. The field's value before either was checked
  // is remembered and restored if both end up unchecked again, so
  // reconsidering doesn't force re-picking from scratch.
  let valueBeforeSkip = "";
  function setSkip(filteredOut, ignored) {
    field.disabled = filteredOut || ignored;
    if (filteredOut || ignored) {
      valueBeforeSkip = field.value || valueBeforeSkip;
      field.value = "";
    } else {
      field.value = valueBeforeSkip;
    }
  }

  const filterOutLabel = document.createElement("label");
  filterOutLabel.className = "skip-toggle";
  const filterOutCheckbox = document.createElement("input");
  filterOutCheckbox.type = "checkbox";
  filterOutCheckbox.checked = isFilteredOut;
  filterOutLabel.append(filterOutCheckbox, " Filter out");
  filterOutLabel.title = "Drop this row from the dataset entirely";
  fieldWrap.appendChild(filterOutLabel);

  const ignoreLabel = document.createElement("label");
  ignoreLabel.className = "skip-toggle";
  const ignoreCheckbox = document.createElement("input");
  ignoreCheckbox.type = "checkbox";
  ignoreCheckbox.checked = isIgnored;
  ignoreLabel.append(ignoreCheckbox, " Ignore");
  ignoreLabel.title = "Leave this target blank for this row, but keep the row";
  fieldWrap.appendChild(ignoreLabel);

  filterOutCheckbox.addEventListener("change", () => {
    if (filterOutCheckbox.checked) ignoreCheckbox.checked = false;
    setSkip(filterOutCheckbox.checked, ignoreCheckbox.checked);
  });
  ignoreCheckbox.addEventListener("change", () => {
    if (ignoreCheckbox.checked) filterOutCheckbox.checked = false;
    setSkip(filterOutCheckbox.checked, ignoreCheckbox.checked);
  });

  tr.appendChild(targetTd);

  if (showPriorYear) {
    const prevTd = document.createElement("td");
    const match = group.prior_year_match;
    if (match) {
      const pill = document.createElement(match.street_view_url ? "a" : "span");
      pill.className = "prior-year-pill";
      pill.textContent = match.value;
      if (match.street_view_url) {
        pill.href = match.street_view_url;
        pill.target = "_blank";
        pill.rel = "noopener";
        pill.title = "Open the street view image this decision was based on";
      }
      prevTd.appendChild(pill);
    }
    tr.appendChild(prevTd);
  }

  if (streetViewEnabled) {
    const svTd = document.createElement("td");
    const svBtn = document.createElement("button");
    svBtn.textContent = "Inspect";
    svBtn.title = "Street View, sampled values, and this group's network on a map";
    svBtn.className = "sv-btn";
    svBtn.addEventListener("click", () => openStreetView(target, group));
    svTd.appendChild(svBtn);
    tr.appendChild(svTd);
  }

  const ref = {
    group, field, filterOutCheckbox, ignoreCheckbox, initialValue, initialMethod,
    flag: group.flag || "", notes: group.notes || "",
  };

  const flagTd = document.createElement("td");
  ref.flagBtn = document.createElement("button");
  ref.flagBtn.type = "button";
  ref.flagBtn.addEventListener("click", () => openFlagModal(ref));
  updateFlagButton(ref);
  flagTd.appendChild(ref.flagBtn);
  tr.appendChild(flagTd);

  return { tr, ref };
}

// --- Target sections (one per tab) --------------------------------------

const targetDataByName = {}; // target -> targetData, kept for tab status recompute after a save
const targetRowRefs = {}; // target -> [{group, field, filterOutCheckbox, ignoreCheckbox, initialValue, initialMethod, flag, notes, flagBtn}], read by saveTarget()

// not_applicable: no source columns configured/present, or no value combos
// at all. not_started: nothing saved yet. complete: every combo has a saved
// mapping. needs_review: some but not all. Mirrors status.py's
// target_status() exactly, but derived from the groups this page already
// has in hand (each carries confidence: "saved" when it came off disk)
// rather than a second request — status.py's version exists for /api/sources,
// which needs it for every source at once, not just the one open here.
function computeTargetStatus(targetData) {
  if (!targetData.source_columns.length || !targetData.groups.length) return "not_applicable";
  const covered = targetData.groups.filter((g) => g.confidence === "saved").length;
  if (covered === 0) return "not_started";
  return covered === targetData.groups.length ? "complete" : "needs_review";
}

function updateTabStatus(target) {
  const status = computeTargetStatus(targetDataByName[target]);
  const badge = document.querySelector(`.target-tab[data-target="${target}"] .status`);
  if (badge) {
    badge.className = `status status-${status}`;
    badge.textContent = status.replace(/_/g, " ");
  }
}

function renderTargetSection(target, targetData) {
  const section = document.createElement("section");
  section.className = "target-section hidden";
  section.dataset.target = target;

  if (!targetData.source_columns.length) {
    const note = document.createElement("div");
    note.className = "meta target-na-note";
    note.textContent = "Not applicable — none of this target's configured source columns exist for this source.";
    section.appendChild(note);
    return section;
  }

  const columns = targetData.source_columns;
  const table = document.createElement("table");

  const colgroup = document.createElement("colgroup");
  // No width on the raw value columns: they share whatever the fixed ones
  // below leave, and long values wrap rather than forcing a side-scroll.
  for (const _ of columns) {
    colgroup.appendChild(document.createElement("col"));
  }
  for (const width of ["70px", "345px"]) {
    const col = document.createElement("col");
    col.style.width = width;
    colgroup.appendChild(col);
  }
  if (targetData.show_prior_year) {
    const col = document.createElement("col");
    col.style.width = "165px";
    colgroup.appendChild(col);
  }
  if (targetData.street_view) {
    const col = document.createElement("col");
    col.style.width = "85px";
    colgroup.appendChild(col);
  }
  const flagCol = document.createElement("col");
  flagCol.style.width = "95px";
  colgroup.appendChild(flagCol);
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.className = "value-cell";
    th.textContent = col;
    headRow.appendChild(th);
  }
  for (const label of ["Count", "Target"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  if (targetData.show_prior_year) {
    const th = document.createElement("th");
    th.textContent = priorYearLabel();
    headRow.appendChild(th);
  }
  if (targetData.street_view) {
    const th = document.createElement("th");
    th.textContent = "Inspect";
    headRow.appendChild(th);
  }
  const flagTh = document.createElement("th");
  flagTh.textContent = "Review";
  headRow.appendChild(flagTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const refs = [];
  for (const group of targetData.groups) {
    const { tr, ref } = renderGroupRow(
      target, group, columns, targetData.options, targetData.street_view, targetData.show_prior_year
    );
    tbody.appendChild(tr);
    refs.push(ref);
  }
  targetRowRefs[target] = refs;
  table.appendChild(tbody);

  const wrap = document.createElement("div");
  wrap.className = "table-scroll";
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

// --- Tabs -----------------------------------------------------------------

function renderTabs(targetNames) {
  const bar = document.getElementById("target-tabs");
  bar.innerHTML = "";
  for (const target of targetNames) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "target-tab";
    btn.dataset.target = target;

    const label = document.createElement("span");
    label.className = "target-tab-label";
    label.textContent = target;
    btn.appendChild(label);

    const status = computeTargetStatus(targetDataByName[target]);
    const badge = document.createElement("span");
    badge.className = `status status-${status}`;
    badge.textContent = status.replace(/_/g, " ");
    btn.appendChild(badge);

    btn.addEventListener("click", () => setActiveTarget(target));
    bar.appendChild(btn);
  }
}

function setActiveTarget(target) {
  activeTarget = target;
  visitedTargets.add(target);
  for (const btn of document.querySelectorAll(".target-tab")) {
    btn.classList.toggle("active", btn.dataset.target === target);
  }
  for (const section of document.querySelectorAll(".target-section")) {
    section.classList.toggle("hidden", section.dataset.target !== target);
  }
  // Scopes the header's "Edit matching rules" link to whichever target is
  // currently on screen, since each target has its own rules — see
  // schema/classification_matching_rules.yaml and setup's editor.
  const rulesLink = document.getElementById("rules-edit-link");
  if (rulesLink) rulesLink.href = `/setup/classification_matching_rules.html?target=${encodeURIComponent(target)}`;
  updateStickyOffsets();
}

// Next tab (in tab order, wrapping around, excluding the current one) that
// still needs work — what "Save & next" advances to before falling back to
// findNextSource's whole-other-source search, so finishing one target on a
// source lands you on the next one still to do (e.g. canbics_class ->
// status) rather than bouncing straight to a different source.
function findNextIncompleteTarget(current) {
  const startIdx = allTargetNames.indexOf(current);
  for (let i = 1; i <= allTargetNames.length; i++) {
    const t = allTargetNames[(startIdx + i) % allTargetNames.length];
    if (t === current) continue;
    const status = computeTargetStatus(targetDataByName[t]);
    if (status === "not_started" || status === "needs_review") return t;
  }
  return null;
}

// table-scroll gets a real max-height so it fills the viewport below the
// sticky header (and tab bar) without pushing the footer off-screen — same
// approach as column-mapping's map.js, measuring the currently-visible
// table-scroll's own position rather than summing nav/header offsetHeight
// (which misses the CSS margins between them).
function updateStickyOffsets() {
  const nav = document.querySelector(".geomerge-nav");
  document.documentElement.style.setProperty("--nav-height", `${nav ? nav.offsetHeight : 0}px`);
  const tableScroll = document.querySelector(".target-section:not(.hidden) .table-scroll");
  if (tableScroll) {
    const topOffset = tableScroll.getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty("--header-height", `${topOffset}px`);
  }
}
window.addEventListener("resize", updateStickyOffsets);

// Both buttons disabled for the whole operation, same reasoning as
// column-mapping's map.js: the save + "find next" sequence below is a few
// requests deep, and leaving either button live invites a double-submit
// while the first is still in flight, with no visible sign anything is
// happening.
function setSaving(inProgress, message) {
  document.getElementById("save-btn").disabled = inProgress;
  document.getElementById("save-next-btn").disabled = inProgress;
  document.getElementById("flag-next-btn").disabled = inProgress;
  document.getElementById("save-status").textContent = message || "";
}

// Bulk-saves every row of one tab in a single request — the "single save
// button at bottom" model, replacing the old per-row auto-save. A row left
// blank (no target value, not marked "Not included") is simply omitted
// rather than sent empty, so it stays not_started/needs_review rather than
// being saved as nothing. Returns true on success (with
// targetDataByName/tab status already refreshed) or false on failure (with
// the failure message already written to #save-status).
// A row's effective target value — whichever of Filter out / Ignore /
// the real field is currently in play. Neither checkbox can be checked at
// once (see renderGroupRow's mutual-exclusion wiring), so this is a plain
// priority order, not a real conflict to resolve.
function rowValue(ref) {
  if (ref.filterOutCheckbox.checked) return appConfig.not_included_value;
  if (ref.ignoreCheckbox.checked) return appConfig.ignored_value;
  return ref.field.value.trim();
}

// --- Unsaved changes ------------------------------------------------------
// A row counts as changed once it differs from how the page loaded it or how
// it was last saved, so a pre-filled suggestion left alone isn't a change.

function rowSnapshot(ref) {
  return JSON.stringify([rowValue(ref), ref.flag || "", ref.notes || ""]);
}

function markRowsSaved(refs) {
  for (const ref of refs) ref.savedSnapshot = rowSnapshot(ref);
}

function hasUnsavedChanges() {
  if (document.getElementById("source-notes").value.trim() !== savedSourceNotes) return true;
  return Object.values(targetRowRefs).some((refs) => refs.some((ref) => rowSnapshot(ref) !== ref.savedSnapshot));
}

let leavingPage = false;
let pendingBackHref = null;

function leaveTo(href) {
  leavingPage = true;
  location.href = href;
}

function closeUnsavedModal() {
  pendingBackHref = null;
  document.getElementById("unsaved-modal").classList.add("hidden");
}

document.querySelector(".back-link").addEventListener("click", (e) => {
  if (!hasUnsavedChanges()) return;
  e.preventDefault();
  pendingBackHref = e.currentTarget.href;
  document.getElementById("unsaved-modal").classList.remove("hidden");
});

document.getElementById("unsaved-save-btn").addEventListener("click", async () => {
  const href = pendingBackHref;
  closeUnsavedModal();
  setSaving(true, "Saving\u2026");
  const ok = (await saveSourceNotes()) && (await saveVisitedTargets());
  if (ok) leaveTo(href); // on failure, the error is showing and the edits are still on the page
});

document.getElementById("unsaved-discard-btn").addEventListener("click", () => leaveTo(pendingBackHref));
document.getElementById("unsaved-stay-btn").addEventListener("click", closeUnsavedModal);
document.getElementById("unsaved-modal").addEventListener("click", (e) => {
  if (e.target.id === "unsaved-modal") closeUnsavedModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeUnsavedModal();
});

// The other ways off the page (nav tabs, refresh, closing the tab) can only use
// the browser's own prompt.
window.addEventListener("beforeunload", (e) => {
  if (!leavingPage && hasUnsavedChanges()) e.preventDefault();
});

async function saveTarget(target) {
  const refs = targetRowRefs[target] || [];

  // A blank row isn't saved, so its flag or note would silently vanish —
  // stop here instead, on the tab the row is on.
  const stranded = refs.find((ref) => !rowValue(ref) && (ref.flag || ref.notes));
  if (stranded) {
    setActiveTarget(target);
    setSaving(false, `"${groupLabel(stranded.group)}" has a flag or note but no target — choose one or clear it`);
    return false;
  }

  const entries = [];
  for (const ref of refs) {
    const value = rowValue(ref);
    if (!value) continue;
    const isSkip = ref.filterOutCheckbox.checked || ref.ignoreCheckbox.checked;
    const method = !isSkip && value === ref.initialValue && ref.initialMethod === "rule" ? "rule" : "manual";
    entries.push({ values: ref.group.values, target_value: value, method, flag: ref.flag, notes: ref.notes });
  }

  if (!entries.length) {
    // Nothing changed on this tab — not an error, just nothing to send.
    markRowsSaved(refs);
    return true;
  }

  try {
    const res = await fetch(`api/classification/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, entries }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaving(false, data.error || "Failed to save");
      return false;
    }
  } catch (e) {
    setSaving(false, `Something went wrong: ${e}`);
    return false;
  }

  for (const ref of refs) {
    if (rowValue(ref)) ref.group.confidence = "saved";
  }
  markRowsSaved(refs);
  updateTabStatus(target);
  return true;
}

// Only sent when it actually changed, so a Save that touches nothing else
// doesn't rewrite the file (and mark processing stale) just for this.
let savedSourceNotes = "";

async function saveSourceNotes() {
  const notes = document.getElementById("source-notes").value.trim();
  if (notes === savedSourceNotes) return true;
  try {
    const res = await fetch(`api/classification/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_notes: notes }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaving(false, data.error || "Failed to save");
      return false;
    }
  } catch (e) {
    setSaving(false, `Something went wrong: ${e}`);
    return false;
  }
  savedSourceNotes = notes;
  return true;
}

// Saves every tab opened on this page load, so an edit on an earlier tab isn't
// lost. An unopened tab is left alone: its rows are pre-filled with suggestions
// nobody has reviewed, and saving those would mark the tab complete. Stops at
// the first failure, same fail-fast behavior saveTarget has for a single tab.
async function saveVisitedTargets() {
  for (const target of allTargetNames) {
    if (!visitedTargets.has(target)) continue;
    const ok = await saveTarget(target);
    if (!ok) return false;
  }
  return true;
}

// A flagged source is waiting on something outside this tool, so "next" skips it.
function isIncomplete(s) {
  return !s.flagged && s.has_preprocessed_data && Object.values(s.targets).some((t) => t !== "complete" && t !== "not_applicable");
}

async function loadClassifiedCount() {
  const res = await fetch("api/sources");
  const sources = await res.json();
  const rolledUp = (s) => {
    const values = Object.values(s.targets);
    if (!values.length || values.every((v) => v === "not_applicable")) return "not_applicable";
    return values.every((v) => v === "complete" || v === "not_applicable") ? "complete" : "not_complete";
  };
  const classifiedCount = sources.filter((s) => rolledUp(s) === "complete").length;
  document.getElementById("classified-count").textContent = `${classifiedCount} / ${sources.length} sources classified`;
}

async function load() {
  document.getElementById("source-label").innerHTML =
    `<span class="field-label">Source ID:</span> <button type="button" class="field-value source-card-trigger">${escapeHtml(sourceId)}</button>`;
  document.querySelector("#source-label .source-card-trigger").addEventListener("click", () => openSourceCard(sourceId));

  document.getElementById("file-paths").innerHTML =
    `<span class="field-label">Reading:</span> <span class="field-value">data/preprocessing/${escapeHtml(sourceId)}/${escapeHtml(sourceId)}.parquet</span>`;

  const classificationMapPath = `sources/${sourceId}/classification_map.yaml`;
  const fileLink = document.getElementById("footer-file-link");
  fileLink.textContent = classificationMapPath;
  fileLink.onclick = () => openFilePreview(classificationMapPath, `api/classification/${encodeURIComponent(sourceId)}/raw`);

  // Any failure here — network, non-JSON error body, anything — ends in a
  // visible message rather than the page just silently never loading (same
  // fix column-mapping's map.js already applies to its own load()).
  let configRes, dataRes, appConfigData, data;
  try {
    [configRes, dataRes] = await Promise.all([
      fetch("api/config"),
      fetch(`api/classification/${encodeURIComponent(sourceId)}`),
    ]);
    appConfigData = await configRes.json();
    data = await dataRes.json();
  } catch (e) {
    const err = document.getElementById("error");
    err.textContent = `Failed to load: ${e}`;
    err.classList.remove("hidden");
    return;
  }
  appConfig = appConfigData;

  if (!dataRes.ok) {
    const err = document.getElementById("error");
    err.textContent = data.error;
    err.classList.remove("hidden");
    return;
  }

  const container = document.getElementById("targets");
  container.innerHTML = "";
  valueLabels = data.value_labels || {};
  dataDictionaryUrl = data.data_dictionary_url || "";
  allTargetNames = Object.keys(data.targets);
  for (const target of allTargetNames) {
    targetDataByName[target] = data.targets[target];
    container.appendChild(renderTargetSection(target, data.targets[target]));
  }

  savedSourceNotes = data.source_notes || "";
  document.getElementById("source-notes").value = savedSourceNotes;
  sourceFlagged = !!data.source_flagged;
  updateFlagNextButton();
  document.getElementById("source-notes-wrap").classList.remove("hidden");

  renderTabs(allTargetNames);

  // Default to the first tab that still needs work, so opening a source
  // drops you where there's something to do rather than always canbics_class.
  const firstIncomplete = allTargetNames.find((t) => {
    const status = computeTargetStatus(targetDataByName[t]);
    return status === "not_started" || status === "needs_review";
  });
  setActiveTarget(firstIncomplete || allTargetNames[0]);

  for (const refs of Object.values(targetRowRefs)) markRowsSaved(refs);

  loadClassifiedCount();
}

function updateFlagNextButton() {
  document.getElementById("flag-next-btn").textContent = sourceFlagged ? "\u2691 Remove flag" : "\u2691 Flag & next";
}

async function saveSourceFlag(flagged) {
  try {
    const res = await fetch(`api/classification/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_flagged: flagged }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaving(false, data.error || "Failed to save");
      return false;
    }
  } catch (e) {
    setSaving(false, `Something went wrong: ${e}`);
    return false;
  }
  sourceFlagged = flagged;
  updateFlagNextButton();
  return true;
}

async function goToNextSource() {
  setSaving(true, "Finding next source\u2026");
  const nextSourceId = await findNextSource(sourceId, "api/sources", isIncomplete);
  if (nextSourceId) {
    location.href = `review.html?id=${encodeURIComponent(nextSourceId)}`;
  } else {
    goHome();
  }
}

// Checkpoint: saves and stays right here, for a source complicated enough to
// span several tabs before any one of them feels "done".
document.getElementById("save-btn").addEventListener("click", async () => {
  setSaving(true, "Saving\u2026");
  const ok = (await saveSourceNotes()) && (await saveVisitedTargets());
  if (ok) setSaving(false, "Saved \u2713"); // on failure, the error is already showing
});

// Saves, then advances: to the next tab still needing work on this source if
// there is one, otherwise to the next source (or home).
document.getElementById("save-next-btn").addEventListener("click", async () => {
  setSaving(true, "Saving\u2026");
  const ok = (await saveSourceNotes()) && (await saveVisitedTargets());
  if (!ok) return;

  const nextTarget = findNextIncompleteTarget(activeTarget);
  if (nextTarget) {
    setActiveTarget(nextTarget);
    setSaving(false, "Saved \u2713");
    return;
  }
  await goToNextSource();
});

// Parks the source until something outside this tool is resolved, e.g. a reply
// from the municipality. The source note is required so the reason is on record.
// On an already-flagged source this is the way back, and it stays on the page.
document.getElementById("flag-next-btn").addEventListener("click", async () => {
  if (sourceFlagged) {
    setSaving(true, "Removing flag\u2026");
    if (await saveSourceFlag(false)) setSaving(false, "Flag removed \u2713");
    return;
  }

  const notes = document.getElementById("source-notes");
  if (!notes.value.trim()) {
    notes.focus();
    setSaving(false, "Add a source note saying why this is flagged");
    return;
  }

  setSaving(true, "Flagging\u2026");
  const ok = (await saveSourceNotes()) && (await saveVisitedTargets()) && (await saveSourceFlag(true));
  if (ok) await goToNextSource();
});

load();
