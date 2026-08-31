// Applies the stored (or default) theme before first paint. Loaded as a
// plain blocking <script> (no defer/async) in every page's <head>, right
// after colors.css, so [data-theme] lands on <html> before the browser
// paints anything — an async/deferred script would let the page flash
// Latte for a frame even when Frappé is stored. toggleTheme() below is the
// click handler every page's nav toggle button (see nav.css/nav markup)
// calls; it isn't run at load, only on click.
(function () {
  var stored = localStorage.getItem("geomerge-theme");
  document.documentElement.dataset.theme = stored === "dark" ? "dark" : "light";
})();

function toggleTheme() {
  var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("geomerge-theme", next);
}
