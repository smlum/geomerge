// Generic read-only raw-file preview modal — for pages that are already
// the editor for a file (setup's schema/column-matching-rules pages,
// column_mapping's map.html) and just want a "here's the actual file on
// disk" peek from the footer's clickable "editing: ..." link. Unlike
// home/app.js's openYamlModal (which also offers a jump-to-edit link),
// there's no edit action here — the current page already is that editor.
//
// Loaded via an absolute <script src="/file-preview.js">, same reasoning as
// nav.js/rule-editor.js: one copy, not one per tool. Expects the host page
// to provide #file-preview-modal/-title/-path/-content (modal.css chrome +
// a .code-block.hljs <pre>, same markup shape as home's #yaml-modal) and to
// have already loaded highlight.js + hljs-theme.css for the hljs global.
async function openFilePreview(title, fetchUrl) {
  document.getElementById("file-preview-title").textContent = title;
  document.getElementById("file-preview-path").textContent = "";
  const content = document.getElementById("file-preview-content");
  content.textContent = "Loading…";
  document.getElementById("file-preview-modal").classList.remove("hidden");

  const res = await fetch(fetchUrl);
  if (!res.ok) {
    content.textContent = "Failed to load file.";
    return;
  }
  const data = await res.json();
  document.getElementById("file-preview-path").textContent = data.path;
  content.innerHTML = hljs.highlight(data.content, { language: "yaml" }).value;
}

function closeFilePreview() {
  document.getElementById("file-preview-modal").classList.add("hidden");
}
