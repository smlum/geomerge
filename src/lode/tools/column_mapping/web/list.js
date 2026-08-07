async function load() {
  const res = await fetch("/api/sources");
  const sources = await res.json();
  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of sources) {
    body.appendChild(renderRow(s));
  }
}

function flagCell(ok) {
  const td = document.createElement("td");
  td.innerHTML = ok ? `<span class="flag flag-yes">yes</span>` : `<span class="flag flag-no">no</span>`;
  return td;
}

function renderRow(s) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = s.source_id;
  tr.appendChild(nameTd);

  tr.appendChild(flagCell(s.has_data));
  tr.appendChild(flagCell(s.has_metadata));

  const statusTd = document.createElement("td");
  statusTd.innerHTML = `<span class="status status-${s.column_map_status}">${s.column_map_status.replace("_", " ")}</span>`;
  tr.appendChild(statusTd);

  const actionTd = document.createElement("td");
  const ready = s.has_data && s.has_metadata;
  if (ready) {
    const link = document.createElement("a");
    link.className = "map-link";
    link.href = `map.html?id=${encodeURIComponent(s.source_id)}`;
    link.textContent = s.column_map_status === "not_started" ? "Map columns" : "Review";
    actionTd.appendChild(link);
  } else {
    const missing = [];
    if (!s.has_metadata) missing.push("metadata");
    if (!s.has_data) missing.push("data");
    actionTd.innerHTML = `<span class="meta">missing ${missing.join(" & ")}</span>`;
  }
  tr.appendChild(actionTd);

  return tr;
}

load();
