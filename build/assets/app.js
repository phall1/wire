// Vanilla client search. Fetches /search-index.json and filters by
// title / aliases / summary as you type. No deps. Used on home + family pages.
(function () {
  var input = document.getElementById("q");
  var results = document.getElementById("results");
  if (!input || !results) return;

  var family = input.getAttribute("data-family"); // null on home page
  var index = null;

  function row(e) {
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "/" + e.id;
    a.textContent = e.title;
    li.appendChild(a);
    if (e.summary) {
      var s = document.createElement("div");
      s.className = "note";
      s.textContent = e.summary;
      li.appendChild(s);
    }
    return li;
  }

  function render(list) {
    results.innerHTML = "";
    for (var i = 0; i < list.length && i < 100; i++) results.appendChild(row(list[i]));
  }

  function matches(e, q) {
    if ((e.title || "").toLowerCase().indexOf(q) !== -1) return true;
    if ((e.summary || "").toLowerCase().indexOf(q) !== -1) return true;
    var a = e.aliases || [];
    for (var i = 0; i < a.length; i++) if (a[i].toLowerCase().indexOf(q) !== -1) return true;
    return e.id.toLowerCase().indexOf(q) !== -1;
  }

  function update() {
    if (!index) return;
    var q = input.value.trim().toLowerCase();
    if (!q && family) return; // family page: leave server-rendered list intact
    var pool = family ? index.filter(function (e) { return e.family === family; }) : index;
    render(q ? pool.filter(function (e) { return matches(e, q); }) : (family ? pool : []));
  }

  fetch("/search-index.json")
    .then(function (r) { return r.json(); })
    .then(function (data) { index = data; update(); })
    .catch(function () { /* search index unavailable; static list stands */ });

  input.addEventListener("input", update);
})();
