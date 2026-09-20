/* Local UI diagnostics for comparing the same panel in Chromium and UXP.
 * Records geometry/style/capability metadata only; never input values, document
 * names, image data, stored task records, or network request bodies.
 */
(function () {
  "use strict";
  var BUILD = "015-button-scale-20260912";
  var enabled = true;
  var reports = [];
  var interactions = [];
  var probes = null;
  var saveChain = Promise.resolve();
  var pending = null;
  var selectors = [
    "html", "body", "#app", ".panel-scrollbar", ".panel-scrollbar-thumb", "header.chrome", ".brand", ".brand-light", ".brand-dark", ".sub", ".modes", ".tab", ".tab-line",
    "#agentStatus", "#agentMessages", ".agent-item-body", ".md-table", ".md-codeblock", "#agentProgress", "#agentError", "#pane-agent", "#th", "#emptyChips", ".human-chip", "#log",
    "#agentHistory", "#agentNew", "#agentAttachFile", "#agentAttachSelection", "#agentNewline", ".agent-copy", ".agent-history-option", ".agent-model-option", ".scale-options .ui-button",
    "#recordsDrawer", ".record-meta", ".record-rerun", ".ctx",
    ".composer", ".row2", "#prompt", "#go", "#selChips",
    "#pane-pro", "#proBody", "#proL", "#proR", "#proHist",
    "#compile", "#recipeQ", "#proTa", "#applyBtn", "#pane-settings",
    "#compRetry", "#themePick", ".radio-option", ".radio-mark", ".ret", ".sw", ".field"
  ];
  var styleKeys = [
    "display", "position", "fontFamily", "fontSize", "fontWeight",
    "lineHeight", "letterSpacing", "flexDirection", "flexGrow",
    "flexShrink", "flexBasis", "flexWrap", "gap", "rowGap", "columnGap",
    "padding", "margin", "minWidth", "minHeight", "overflow", "overflowX", "overflowY",
    "color", "backgroundColor", "opacity", "appearance",
    "borderBottomWidth", "borderBottomStyle", "borderBottomColor", "borderRadius"
  ];

  function round(n) {
    return typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function rect(e) {
    var r = e.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  }
  function describe(e) {
    var c = getComputedStyle(e);
    var styles = {};
    styleKeys.forEach(function (key) {
      styles[key] = c[key] === undefined ? null : String(c[key]);
    });
    var disabled = typeof e.disabled === "boolean" ? e.disabled : null;
    if (e.getAttribute("role") === "button" && window.PXD_UI) disabled = window.PXD_UI.isDisabled(e);
    var result = { rect: rect(e), scroll: { width: e.scrollWidth, height: e.scrollHeight, clientWidth: e.clientWidth, clientHeight: e.clientHeight, top: round(e.scrollTop), left: round(e.scrollLeft) }, hidden: e.hasAttribute("hidden"), disabled: disabled, focused: document.activeElement === e, role: e.getAttribute("role"), tabIndex: e.getAttribute("tabindex"), styles: styles };
    if (result.role === "scrollbar") {
      result.scrollbar = { owner: e.getAttribute("aria-controls"), max: e.getAttribute("aria-valuemax"), value: e.getAttribute("aria-valuenow") };
    }
    return result;
  }
  function spacing(selector) {
    var e = document.querySelector(selector);
    if (!e) return null;
    var children = Array.from(e.children).map(function (child) {
      return { tag: child.tagName, rect: rect(child) };
    }).filter(function (child) { return child.rect.width > 0 && child.rect.height > 0; });
    var gaps = [];
    for (var i = 1; i < children.length; i++) {
      var a = children[i - 1].rect;
      var b = children[i].rect;
      if (Math.abs(a.y - b.y) < 1) gaps.push(round(b.x - a.x - a.width));
    }
    return { children: children, horizontalGaps: gaps };
  }
  function runtime() {
    var r = {
      build: BUILD, host: "browser", theme: document.documentElement.getAttribute("data-theme"),
      appClass: document.getElementById("app").className,
      uiScale: window.PXD_SCALE ? window.PXD_SCALE.factor() : 1,
      devicePixelRatio: window.devicePixelRatio || null,
      resizeObserver: typeof ResizeObserver !== "undefined",
      fontFaceSet: !!document.fonts,
      assets: Array.from(document.querySelectorAll("link,script[src]")).map(function (e) {
        return e.getAttribute("href") || e.getAttribute("src");
      })
    };
    try {
      var uxp = require("uxp");
      r.host = "uxp";
      r.uxpVersion = uxp.versions.uxp;
      r.pluginVersion = uxp.plugin && uxp.plugin.version;
      r.hostName = uxp.host && uxp.host.name;
      r.hostVersion = uxp.host && uxp.host.version;
    } catch (_) {}
    return r;
  }
  function snapshot(reason) {
    var result = { at: new Date().toISOString(), reason: reason || "manual", runtime: runtime(), probes: probes, interactions: interactions.slice(), elements: {}, spacing: {} };
    selectors.forEach(function (selector) {
      var e = document.querySelector(selector);
      if (e) result.elements[selector] = describe(e);
    });
    [".modes", "#emptyChips", ".row2", "#selChips", "#proSelChips"].forEach(function (s) {
      result.spacing[s] = spacing(s);
    });
    return result;
  }
  function save() {
    var payload = JSON.stringify({ build: BUILD, reports: reports }, null, 2);
    saveChain = saveChain.catch(function () {}).then(async function () {
      var uxp;
      try { uxp = require("uxp"); } catch (_) { return null; }
      var folder = await uxp.storage.localFileSystem.getDataFolder();
      var file = await folder.createFile("ui-diagnostics-014.json", { overwrite: true });
      await file.write(payload);
      return file.nativePath;
    });
    return saveChain;
  }
  function capture(reason) {
    var result = snapshot(reason);
    api.latest = result;
    reports.push(result);
    if (reports.length > 8) reports.shift();
    console.log("[PXD:UI] " + result.reason + " runtime " + JSON.stringify(result.runtime));
    if (probes) console.log("[PXD:UI] probes " + JSON.stringify(probes));
    Object.keys(result.spacing).forEach(function (s) {
      console.log("[PXD:UI] spacing " + s + " " + JSON.stringify(result.spacing[s]));
    });
    ["#app", ".brand", "#prompt", "#go", "#agentHistory", "#agentAttachSelection", ".agent-copy", "#proBody"].forEach(function (s) {
      var e = result.elements[s];
      if (!e) return;
      console.log("[PXD:UI] element " + s + " " + JSON.stringify({
        rect: e.rect, font: e.styles.fontFamily, size: e.styles.fontSize,
        line: e.styles.lineHeight, display: e.styles.display
      }));
    });
    save().then(function (path) {
      if (path && !api.filePath) {
        api.filePath = path;
        console.log("[PXD:UI] local log " + path);
      }
    }).catch(function (error) { console.warn("[PXD:UI] local log save failed: " + String(error.message || error)); });
    return result;
  }
  function schedule(reason) {
    if (!enabled) return;
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (!enabled) return;
      try { capture(reason); } catch (error) { console.warn("[PXD:UI] capture failed: " + String(error.message || error)); }
    }, 250);
  }
  function runProbes() {
    var root = document.createElement("div");
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:absolute;left:0;top:0;width:640px;height:240px;opacity:0;pointer-events:none;";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:17px;width:100px;height:10px;";
    for (var i = 0; i < 2; i++) {
      var item = document.createElement("div");
      item.style.cssText = "width:10px;height:10px;flex:none;margin:0;padding:0;";
      row.appendChild(item);
    }
    root.appendChild(row);
    var families = ["Menlo", "Consolas", "Courier New", "Arial", "__PXD_MISSING_FONT__"];
    var samples = families.map(function (family) {
      var sample = document.createElement("span");
      sample.textContent = "PXD/LS studio iii WWW 012345";
      sample.style.cssText = "display:inline-block;white-space:nowrap;font-size:22px;line-height:24px;font-weight:400;margin:0;padding:0;";
      sample.style.fontFamily = '"' + family + '"';
      root.appendChild(sample);
      return sample;
    });
    document.body.appendChild(root);
    setTimeout(function () {
      try {
        var a = rect(row.children[0]);
        var b = rect(row.children[1]);
        probes = {
          flexGap: { requested: 17, measured: round(b.x - a.x - a.width), valid: a.width === 10 && b.width === 10 },
          fontSamples: families.map(function (family, index) {
            return { requested: family, width: rect(samples[index]).width, computed: getComputedStyle(samples[index]).fontFamily };
          })
        };
      } finally {
        if (root.parentNode) root.parentNode.removeChild(root);
        schedule("startup");
      }
    }, 100);
  }
  var api = {
    build: BUILD, latest: null, snapshot: snapshot, capture: capture, save: save, probe: runProbes,
    setEnabled: function (value) { enabled = !!value; if (!enabled) clearTimeout(pending); }
  };
  window.PXD_UI_DIAGNOSTICS = api;
  // Capture control identity/state only, never labels or entered content.
  ["click", "keydown", "keyup"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (!enabled) return;
      if (type !== "click" && event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      var e = event.target;
      while (e && e !== document.body) {
        if (e.classList && e.classList.contains("ui-button")) {
          var item = { at: new Date().toISOString(), control: e.id || e.className, event: type, disabled: window.PXD_UI.isDisabled(e), focused: document.activeElement === e };
          interactions.push(item);
          if (interactions.length > 30) interactions.shift();
          console.log("[PXD:UI] control " + JSON.stringify(item));
          schedule("control-" + type);
          return;
        }
        e = e.parentElement;
      }
    });
  });
  window.addEventListener("resize", function () { schedule("resize"); });
  window.addEventListener("pxd-layout-change", function () { schedule("layout-width"); });
  window.addEventListener("pxd-scale-change", function () { schedule("scale-change"); });
  document.querySelectorAll(".tab,#compBtn,#labDark,#labLight").forEach(function (e) {
    e.addEventListener("click", function () { schedule("view-or-theme"); });
  });
  function startProbes() {
    try { runProbes(); } catch (error) {
      console.warn("[PXD:UI] probe failed: " + String(error.message || error));
      schedule("startup-without-probes");
    }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(startProbes, startProbes);
  else startProbes();
  // A second sample catches deferred host layout and asset loading.
  setTimeout(function () { schedule("settled"); }, 3500);
})();
