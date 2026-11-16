// Cross-page "what is this source" info card — a few highlighted
// metadata.yaml fields plus a full per-stage status summary (the same
// shape home's own dashboard rows use), opened by clicking a source id
// wherever one appears: home/prep's tables, column_mapping's header.
// Read-only itself — this spans every stage at once rather than owning one
// file, so there's no single "edit" action; instead each stage's status
// pill links (new tab) to that stage's own page for this source.
//
// Loaded via an absolute <script src="/source-card.js">, same reasoning as
// nav.js/rule-editor.js/file-preview.js: one copy, not one per tool. Expects
// the host page to provide #source-card-modal/-title/-body (modal.css
// chrome) and to have loaded /source-card.css for the metadata rows and
// status pills — namespaced separately from any one tool's own .status
// classes (home/prep/column_mapping each keep their own for their own
// tables) since this modal has to render identically no matter which page
// opened it, not depend on whatever the host page happens to already define.

// href: where that stage's pill links to (new tab, so jumping back to e.g.
// column mapping mid-classification never costs the current page's unsaved
// state). Per-source deep links where the page supports one (collection's
// ?id= opens that source's metadata modal); the stage's dashboard
// otherwise. Validation has nothing to show yet, so no link.
const SOURCE_CARD_STAGES = [
  { label: "Metadata", path: ["collection", "metadata"], href: (id) => `/collection/?id=${encodeURIComponent(id)}` },
  { label: "Raw data file", path: ["collection", "raw"], href: (id) => `/collection/?id=${encodeURIComponent(id)}` },
  { label: "Column mapping", path: ["tools", "column_mapping"], href: (id) => `/column-mapping/map.html?id=${encodeURIComponent(id)}` },
  { label: "Preprocessing", path: ["tools", "preprocessing"], href: () => "/prep/" },
  { label: "Classification", path: ["tools", "classification"], href: (id) => `/classification/review.html?id=${encodeURIComponent(id)}` },
  { label: "Processing", path: ["pipeline", "processing"], href: () => "/pipeline/" },
  { label: "Validation", path: ["pipeline", "validation"] },
];

// license_name/license_url are handled together, below — a link when
// there's a URL to point it at, plain text otherwise — so they're not
// listed twice here.
const SOURCE_CARD_METADATA_FIELDS = [
  { key: "provider_id", label: "Provider" },
  { key: "format", label: "Format" },
  { key: "retrieved_date", label: "Retrieved" },
  { key: "notes", label: "Notes" },
];

function sourceCardStatusBadge(status) {
  const span = document.createElement("span");
  span.className = `source-card-status source-card-status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

function sourceCardRow(label, valueNode) {
  const row = document.createElement("div");
  row.className = "source-card-row";

  const labelEl = document.createElement("span");
  labelEl.className = "source-card-row-label";
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const valueEl = document.createElement("span");
  valueEl.className = "source-card-row-value";
  valueEl.appendChild(valueNode);
  row.appendChild(valueEl);

  return row;
}

function sourceCardExternalLink(href, text) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = text;
  return link;
}

function sourceCardSection(title) {
  const section = document.createElement("div");
  section.className = "source-card-section";
  const heading = document.createElement("div");
  heading.className = "source-card-section-title";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function getPath(obj, path) {
  return path.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

async function openSourceCard(sourceId) {
  document.getElementById("source-card-title").textContent = sourceId;
  const body = document.getElementById("source-card-body");
  body.innerHTML = '<div class="source-card-empty">Loading…</div>';
  document.getElementById("source-card-modal").classList.remove("hidden");

  let res, data;
  try {
    res = await fetch(`/api/source_info/${encodeURIComponent(sourceId)}`);
    data = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="source-card-empty">Failed to load: ${e}</div>`;
    return;
  }
  if (!res.ok) {
    body.innerHTML = `<div class="source-card-empty">${data.error || "Failed to load"}</div>`;
    return;
  }

  body.innerHTML = "";

  const metaSection = sourceCardSection("Metadata");
  const meta = data.metadata || {};
  let anyMeta = false;

  if (meta.dataset_title) {
    anyMeta = true;
    metaSection.appendChild(sourceCardRow("Title", document.createTextNode(meta.dataset_title)));
  }
  if (meta.dataset_page_url) {
    anyMeta = true;
    metaSection.appendChild(sourceCardRow("Source URL", sourceCardExternalLink(meta.dataset_page_url, "Open ↗")));
  }
  if (meta.portal_url) {
    anyMeta = true;
    metaSection.appendChild(sourceCardRow("Portal", sourceCardExternalLink(meta.portal_url, "Open ↗")));
  }
  for (const field of SOURCE_CARD_METADATA_FIELDS) {
    if (!meta[field.key]) continue;
    anyMeta = true;
    metaSection.appendChild(sourceCardRow(field.label, document.createTextNode(meta[field.key])));
  }
  if (meta.license_name) {
    anyMeta = true;
    const node = meta.license_url ? sourceCardExternalLink(meta.license_url, meta.license_name) : document.createTextNode(meta.license_name);
    metaSection.appendChild(sourceCardRow("License", node));
  }
  if (!anyMeta) {
    const empty = document.createElement("div");
    empty.className = "source-card-empty";
    empty.textContent = "No metadata recorded yet.";
    metaSection.appendChild(empty);
  }
  body.appendChild(metaSection);

  const statusSection = sourceCardSection("Pipeline status");
  for (const stage of SOURCE_CARD_STAGES) {
    const status = getPath(data, stage.path);
    if (status == null) continue;
    let node = sourceCardStatusBadge(status);
    if (stage.href) {
      const link = sourceCardExternalLink(stage.href(sourceId), "");
      link.className = "source-card-stage-link";
      link.title = `Open ${stage.label.toLowerCase()} in a new tab`;
      link.appendChild(node);
      link.appendChild(document.createTextNode(" ↗"));
      node = link;
    }
    statusSection.appendChild(sourceCardRow(stage.label, node));
  }
  // The source's slice of the merged output, in Explore's Overview
  // (filtered via ?source_id=, the same param that page keeps in its URL).
  statusSection.appendChild(sourceCardRow(
    "Results",
    sourceCardExternalLink(`/explore/?source_id=${encodeURIComponent(sourceId)}`, "View in Explore ↗")
  ));
  body.appendChild(statusSection);
}

function closeSourceCard() {
  document.getElementById("source-card-modal").classList.add("hidden");
}

// Provider card — same modal, opened from a dashboard's Provider column:
// the provider's checklist.csv details, its sources (each opens its own
// source card) and a link to its rows in Collect.
async function openProviderCard(providerId) {
  document.getElementById("source-card-title").textContent = providerId;
  const body = document.getElementById("source-card-body");
  body.innerHTML = '<div class="source-card-empty">Loading…</div>';
  document.getElementById("source-card-modal").classList.remove("hidden");

  let res, p;
  try {
    res = await fetch(`/api/provider_info/${encodeURIComponent(providerId)}`);
    p = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="source-card-empty">Failed to load: ${e}</div>`;
    return;
  }
  if (!res.ok) {
    body.innerHTML = `<div class="source-card-empty">${p.error || "Failed to load"}</div>`;
    return;
  }
  document.getElementById("source-card-title").textContent = p.name;
  body.innerHTML = "";

  const details = sourceCardSection("Provider");
  const text = (label, value) => value && details.appendChild(sourceCardRow(label, document.createTextNode(value)));
  text("Province", p.province);
  text("Level", p.geography_level);
  if (p.portal_url) details.appendChild(sourceCardRow("Portal", sourceCardExternalLink(p.portal_url, "Open ↗")));
  if (p.license_name) {
    const node = p.license_url ? sourceCardExternalLink(p.license_url, p.license_name) : document.createTextNode(p.license_name);
    details.appendChild(sourceCardRow("License", node));
  }
  text("Contact", p.contact);
  text("Flag", p.flag);
  text("Notes", p.notes);
  details.appendChild(sourceCardRow(
    "Collect",
    sourceCardExternalLink(`/collection/?q=${encodeURIComponent(p.provider_id)}`, "Open ↗")
  ));
  body.appendChild(details);

  const sources = sourceCardSection("Sources");
  for (const src of p.sources) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "source-card-trigger";
    btn.textContent = src.title || src.source_id;
    btn.title = src.source_id;
    btn.addEventListener("click", () => openSourceCard(src.source_id));
    sources.appendChild(sourceCardRow(src.title ? src.source_id : "", btn));
  }
  if (!p.sources.length) {
    const empty = document.createElement("div");
    empty.className = "source-card-empty";
    empty.textContent = "No sources yet.";
    sources.appendChild(empty);
  }
  body.appendChild(sources);
}
