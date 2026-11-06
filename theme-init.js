// Runs before the page paints so the saved theme never flashes the wrong colours.
(function () {
  try {
    var t = localStorage.getItem('fbx_theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: keep the default dark theme */ }
})();
