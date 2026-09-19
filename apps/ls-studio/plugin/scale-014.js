/* UXP has no reliable display DPI/zoom API. Scale explicit CSS dimensions. */
(function () {
  "use strict";
  var values = [100, 125, 150, 175, 200], percent = 100, buttons = [];
  var isUXP = false;
  try { isUXP = !!require("uxp"); } catch (_) {}
  var dimensions = ["1", "10", "11", "12", "120", "13", "133", "14", "15", "16", "160", "17", "170", "18", "180", "19", "2", "20", "21", "22", "220", "23", "24", "240", "25", "26", "27", "28", "3", "300", "32", "34", "36", "4", "44", "46", "48", "5", "50", "55", "56", "6", "7", "72", "8", "80", "88", "9", "96", "n20", "n4", "n6"];
  try { var stored = Number(localStorage.getItem("pxdls.ui-scale")); if (values.indexOf(stored) >= 0) percent = stored; } catch (_) {}
  function apply(value) {
    if (values.indexOf(value) < 0) return;
    percent = value;
    dimensions.forEach(function (key) {
      var n = Number(key.replace("n", "-").replace("_", "."));
      document.documentElement.style.setProperty("--s" + key, (n * percent / 100) + "px");
    });
    // UXP 8 updates a flex button's computed font after a CSS-variable change,
    // but keeps its anonymous text at the previous size. Recreate only plain
    // labels so glyphs and intrinsic widths follow the new scale. Preserve the
    // button nodes, handlers, focus and any controls containing child elements.
    if (isUXP) document.querySelectorAll(".ui-button").forEach(function (button) {
      if (button.children.length === 0) button.textContent = button.textContent;
    });
    document.getElementById("uiScaleLabel").textContent = percent + "%";
    buttons.forEach(function (b) { var on = b.value === percent; b.node.classList.toggle("is-on", on); b.node.setAttribute("aria-pressed", String(on)); });
    try { localStorage.setItem("pxdls.ui-scale", String(percent)); } catch (_) {}
    window.dispatchEvent(new Event("pxd-scale-change"));
  }
  values.forEach(function (value) {
    var button = window.PXD_UI.createButton("ghost", value + "%", function () { apply(value); });
    buttons.push({ node: button, value: value }); document.getElementById("uiScaleOptions").appendChild(button);
  });
  window.PXD_SCALE = { factor: function () { return percent / 100; }, set: apply };
  apply(percent);
})();
