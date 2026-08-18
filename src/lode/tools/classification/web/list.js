function targetNames(sources) {
  for (const s of sources) {
    const names = Object.keys(s.targets);
    if (names.length) return names;
  }
  return [];
}

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `status status-${status}`;
  span.textContent = status.replace(/_/g, " ");
  return span;
}

function renderRow(s, targets) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.className = "name";
  if (s.has_preprocessed_data) {
    const link = document.createElement("a");
    link.className = "map-link";
    link.href = `review.html?id=${encodeURIComponent(s.source_id)}`;
    link.textContent = s.source_id;
    nameTd.appendChild(link);
  } else {
    nameTd.textContent = s.source_id;
    nameTd.title = "No preprocessed data yet — run 'lode pipeline preprocessing'";
  }
  tr.appendChild(nameTd);

  for (const target of targets) {
    const td = document.createElement("td");
    if (s.has_preprocessed_data) {
      td.appendChild(statusBadge(s.targets[target]));
    } else {
      td.innerHTML = `<span class="meta">—</span>`;
    }
    tr.appendChild(td);
  }

  return tr;
}

async function load() {
  const res = await fetch("/api/sources");
  const sources = await res.json();
  const targets = targetNames(sources);

  const headerRow = document.getElementById("header-row");
  for (const target of targets) {
    const th = document.createElement("th");
    th.textContent = target;
    headerRow.appendChild(th);
  }

  const body = document.getElementById("rows-body");
  body.innerHTML = "";
  for (const s of sources) {
    body.appendChild(renderRow(s, targets));
  }
}

load();
