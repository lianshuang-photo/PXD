/* UXP-only visual rail. The existing overflow container still owns scrolling. */
(function () {
  "use strict";
  try { require("uxp"); } catch (_) { return; }
  var app = document.getElementById("app");
  if (!app) return;
  document.documentElement.classList.add("host-uxp");

  var rail = document.createElement("div"), thumb = document.createElement("div");
  rail.className = "panel-scrollbar";
  rail.setAttribute("role", "scrollbar");
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-valuemin", "0");
  rail.setAttribute("tabindex", "0");
  rail.setAttribute("hidden", "");
  thumb.className = "panel-scrollbar-thumb";
  thumb.setAttribute("aria-hidden", "true");
  rail.appendChild(thumb);
  app.appendChild(rail);

  var state = null, drag = null, lastPaint = "";
  function clamp(n, max) { return Math.max(0, Math.min(max, n)); }
  function owner() {
    if (document.getElementById("pane-settings").classList.contains("is-on")) return document.getElementById("pane-settings");
    if (document.getElementById("pane-pro").classList.contains("is-on")) return document.getElementById("studioBody") || document.getElementById(app.classList.contains("wide") ? "proR" : "proBody");
    return document.getElementById("th");
  }
  function endDrag() {
    drag = null;
    rail.classList.remove("is-dragging");
  }
  function refresh() {
    var scale = window.PXD_SCALE ? window.PXD_SCALE.factor() : 1;
    var target = owner(), box = target.getBoundingClientRect(), root = app.getBoundingClientRect();
    var viewport = target.clientHeight, max = Math.max(0, target.scrollHeight - viewport);
    var length = Math.max(0, box.height - 4);
    var thumbSize = Math.min(length, Math.max(24 * scale, length * viewport / Math.max(1, target.scrollHeight)));
    var top = clamp(target.scrollTop, max), travel = length - thumbSize;
    var offset = max ? travel * top / max : 0;
    if (drag && drag.target !== target) endDrag();
    state = { target: target, max: max, viewport: viewport, top: top, length: length, thumbSize: thumbSize, travel: travel, railY: box.y + 2 };
    var signature = [target.id, max, top, box.y, box.height, root.y, scale].join(":");
    if (signature === lastPaint) return;
    lastPaint = signature;
    if (max < 1 || length < 1) {
      rail.setAttribute("hidden", "");
      endDrag();
      return;
    }
    rail.removeAttribute("hidden");
    rail.style.top = (box.y - root.y + 2) + "px";
    rail.style.height = length + "px";
    thumb.style.height = thumbSize + "px";
    thumb.style.top = offset + "px";
    rail.setAttribute("aria-controls", target.id);
    rail.setAttribute("aria-label", "滚动面板内容");
    rail.setAttribute("aria-valuemax", String(Math.round(max)));
    rail.setAttribute("aria-valuenow", String(Math.round(top)));
  }
  function scrollTo(value) {
    if (!state || typeof value !== "number" || !isFinite(value)) return;
    state.target.scrollTop = clamp(value, state.max);
    refresh();
  }
  rail.addEventListener("mousedown", function (event) {
    if (typeof event.button === "number" && event.button !== 0) return;
    if (typeof event.clientY !== "number" || !isFinite(event.clientY)) return;
    refresh();
    if (!state || !state.max || !state.travel) return;
    event.preventDefault();
    rail.focus();
    var thumbTop = state.railY + state.travel * state.top / state.max;
    var withinThumb = event.clientY >= thumbTop && event.clientY <= thumbTop + state.thumbSize;
    var grab = withinThumb ? event.clientY - thumbTop : state.thumbSize / 2;
    drag = { target: state.target, grab: grab };
    rail.classList.add("is-dragging");
    if (!withinThumb) scrollTo((event.clientY - state.railY - grab) * state.max / state.travel);
  });
  document.addEventListener("mousemove", function (event) {
    if (!drag) return;
    if (typeof event.clientY !== "number" || !isFinite(event.clientY)) return;
    refresh();
    if (!drag || !state.travel) return;
    event.preventDefault();
    scrollTo((event.clientY - state.railY - drag.grab) * state.max / state.travel);
  });
  document.addEventListener("mouseup", endDrag);
  window.addEventListener("blur", endDrag);
  rail.addEventListener("wheel", function (event) {
    refresh();
    var delta = typeof event.deltaY === "number" ? event.deltaY : -(event.wheelDelta || 0);
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= state.viewport;
    if (!delta || !state.max) return;
    event.preventDefault();
    scrollTo(state.top + delta);
  });
  rail.addEventListener("keydown", function (event) {
    refresh();
    var next = state.top;
    if (event.key === "ArrowDown") next += 40;
    else if (event.key === "ArrowUp") next -= 40;
    else if (event.key === "PageDown") next += state.viewport * 0.85;
    else if (event.key === "PageUp") next -= state.viewport * 0.85;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = state.max;
    else return;
    event.preventDefault();
    scrollTo(next);
  });
  ["pane-settings", "th", "studioBody", "proBody", "proR"].forEach(function (id) {
    var target = document.getElementById(id);
    if (target) target.addEventListener("scroll", refresh);
  });
  window.addEventListener("resize", refresh);
  window.addEventListener("pxd-layout-change", refresh);
  // UXP has no ResizeObserver; also catches deferred host layout/content changes.
  // Only the active outer container is measured, and unchanged styles aren't written.
  var timer = setInterval(refresh, 250);
  window.addEventListener("unload", function () { clearInterval(timer); });
  window.PXD_SCROLLBARS = { refresh: refresh };
  refresh();
})();
