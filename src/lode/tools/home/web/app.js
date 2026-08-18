function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

function linkedCell(status, href, boundary) {
  const td = document.createElement("td");
  if (boundary) td.classList.add("group-boundary");
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.appendChild(statusBadge(status));
  td.appendChild(link);
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

function renderRow(s) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = s.source_id;
  tr.appendChild(nameTd);

  // tools/ — human-reviewed, each linking into its own web UI.
  tr.appendChild(linkedCell(s.tools.metadata, `collection/?id=${encodeURIComponent(s.source_id)}`, true));
  tr.appendChild(linkedCell(s.tools.column_mapping, `column-mapping/map.html?id=${encodeURIComponent(s.source_id)}`));
  tr.appendChild(linkedCell(s.tools.classification, `classification/review.html?id=${encodeURIComponent(s.source_id)}`));

  // pipeline/ — mechanical, no review UI to link into yet.
  tr.appendChild(plainCell(s.pipeline.preprocessing, true));
  tr.appendChild(plainCell(s.pipeline.processing));
  tr.appendChild(plainCell(s.pipeline.validation));

  return tr;
}

async function load() {
  const [sourcesRes, summaryRes] = await Promise.all([fetch("api/sources"), fetch("api/summary")]);
  const sources = await sourcesRes.json();
  const summary = (await summaryRes.json()).checklist;

  document.getElementById("summary").textContent =
    `${summary.checked} / ${summary.total} providers checked  ·  ${summary.found} found`;

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of sources) {
    body.appendChild(renderRow(s));
  }
}

load();
