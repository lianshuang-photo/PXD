/* Bounded Photoshop executor. The model supplies IDs, never JavaScript/descriptors. */
(function (root) {
  "use strict";
  function number(v) { return typeof v === "number" ? v : Number(v && (v._value != null ? v._value : v.value != null ? v.value : v)); }
  function read(fn, fallback) { try { var value = fn(); return value == null ? fallback : value; } catch (_) { return fallback; } }
  function bounds(v) {
    if (!v) return null;
    var b = { left: number(v.left), top: number(v.top), right: number(v.right), bottom: number(v.bottom) };
    if (!Object.keys(b).every(function (k) { return isFinite(b[k]); })) return null;
    b.width = b.right - b.left; b.height = b.bottom - b.top; return b;
  }
  function createExecutor(ps, encode, options) {
    options = options || {};
    var studioHost = null;
    function current(id) {
      var doc = ps.app.documents.length ? ps.app.activeDocument : null;
      if (!doc) throw new Error("Photoshop 没有打开的文档");
      if (id != null && doc.id !== id) throw new Error("活动文档已切换，请重新读取文档和图层 ID");
      return doc;
    }
    function tree(doc) {
      var rows = [];
      function visit(layers, parentId, depth) {
        for (var i = 0; i < layers.length; i++) {
          var layer = layers[i]; rows.push({ layer: layer, parentId: parentId, depth: depth, order: i });
          var children = read(function () { return layer.layers; }, []);
          if (children.length) visit(children, layer.id, depth + 1);
        }
      }
      visit(doc.layers, null, 0); return rows;
    }
    function row(entry, detailed) {
      var l = entry.layer;
      var value = { id: l.id, name: String(l.name).slice(0, 1000), parentId: entry.parentId, depth: entry.depth, order: entry.order,
        kind: String(read(function () { return l.kind; }, "unknown")), visible: read(function () { return l.visible; }, null),
        opacity: read(function () { return l.opacity; }, null), blendMode: read(function () { return String(l.blendMode); }, null),
        bounds: read(function () { return bounds(l.bounds); }, null) };
      if (detailed) {
        value.allLocked = read(function () { return l.allLocked; }, null);
        value.isBackgroundLayer = read(function () { return l.isBackgroundLayer; }, null);
        value.text = read(function () { return String(l.textItem.contents).slice(0, 12000); }, null);
      }
      return value;
    }
    function activeIds(doc) { return Array.from(doc.activeLayers || []).map(function (l) { return l.id; }); }
    function find(doc, id) {
      var found = tree(doc).find(function (r) { return r.layer.id === id; });
      if (!found) throw new Error("图层不存在或已被删除，请重新读取图层结构"); return found;
    }
    function check(tool, args, deadline) {
      if (deadline && Date.now() >= deadline) throw new Error("请求已过期，请重新操作");
      var allowed = { photoshop_get_document: [], photoshop_list_layers: ["documentId", "offset", "limit"], photoshop_get_layer: ["documentId", "layerId"], photoshop_get_selection: ["documentId"], photoshop_render_preview: ["documentId", "layerId", "maxEdge"], photoshop_select_layers: ["documentId", "layerIds"] };
      if (!allowed[tool] || !args || Object.keys(args).some(function (k) { return allowed[tool].indexOf(k) < 0; })) throw new Error("不支持的 Photoshop 请求");
      if (tool !== "photoshop_get_document" && (!Number.isInteger(args.documentId) || args.documentId < 1)) throw new Error("文档 ID 无效");
      if ((tool === "photoshop_get_layer" || args.layerId != null) && (!Number.isInteger(args.layerId) || args.layerId < 1)) throw new Error("图层 ID 无效");
      if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw new Error("分页大小无效");
      if (args.offset != null && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error("分页位置无效");
      if (args.maxEdge != null && (!Number.isInteger(args.maxEdge) || args.maxEdge < 128 || args.maxEdge > 1024)) throw new Error("预览尺寸无效");
      if (tool === "photoshop_select_layers" && (!Array.isArray(args.layerIds) || !args.layerIds.length || args.layerIds.length > 20 || new Set(args.layerIds).size !== args.layerIds.length || args.layerIds.some(function (id) { return !Number.isInteger(id) || id < 1; }))) throw new Error("图层列表无效");
    }
    return async function execute(tool, args, deadline) {
      if (["studio_capture", "studio_edit_layer", "studio_apply_result", "studio_rollback"].indexOf(tool) >= 0) {
        if (!studioHost) studioHost = (options.createStudioHost || require("./ps-edit-014.js").createStudioHost)(ps, encode, options.studioOptions || {});
        return studioHost.execute(tool, args, deadline);
      }
      check(tool, args, deadline);
      if (tool === "photoshop_get_document") {
        var docs = Array.from(ps.app.documents).map(function (d) { return { id: d.id, name: d.title || d.name }; });
        if (!docs.length) return { ok: true, open: false, documents: [] };
        var d = current();
        return { ok: true, open: true, documents: docs, document: { id: d.id, name: d.title || d.name, width: number(d.width), height: number(d.height), resolution: d.resolution,
          mode: String(d.mode), layerCount: tree(d).length, selectedLayerIds: activeIds(d), historyStateId: read(function () { return d.activeHistoryState.id; }, null) } };
      }
      var doc = current(args.documentId), result;
      if (tool === "photoshop_list_layers") {
        var rows = tree(doc), offset = args.offset || 0, end = Math.min(rows.length, offset + (args.limit || 100));
        result = { layers: rows.slice(offset, end).map(function (r) { return row(r, false); }), total: rows.length, nextOffset: end < rows.length ? end : null, selectedLayerIds: activeIds(doc) };
      } else if (tool === "photoshop_get_layer") result = { layer: row(find(doc, args.layerId), true) };
      else if (tool === "photoshop_get_selection") {
        var sel = options.readSelection ? await options.readSelection(doc) : bounds(doc.selection && doc.selection.bounds);
        result = { selection: sel || null, hasSelection: !!sel };
      } else if (tool === "photoshop_select_layers") {
        args.layerIds.forEach(function (id) { find(doc, id); });
        await ps.core.executeAsModal(async function () {
          check(tool, args, deadline); current(args.documentId);
          args.layerIds.forEach(function (id) { find(doc, id); });
          var commands = args.layerIds.map(function (id, i) {
            var command = { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } };
            if (i) command.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
            return command;
          });
          var responses = await ps.action.batchPlay(commands, {});
          if (responses.some(function (r) { return r._obj === "error"; })) throw new Error("Photoshop 无法选择这些图层");
        }, { commandName: "LS Studio · 定位图层" });
        result = { selectedLayerIds: activeIds(doc) };
      } else if (tool === "photoshop_render_preview") {
        if (!ps.imaging || !ps.imaging.getPixels) throw new Error("此 Photoshop 版本不提供画布预览接口");
        var source = { left: 0, top: 0, right: number(doc.width), bottom: number(doc.height) };
        if (args.layerId) source = row(find(doc, args.layerId), false).bounds;
        if (!source || source.right <= source.left || source.bottom <= source.top) throw new Error("这个图层没有可预览的像素范围");
        var ratio = Math.min(1, (args.maxEdge || 1024) / Math.max(source.right - source.left, source.bottom - source.top));
        await ps.core.executeAsModal(async function () {
          check(tool, args, deadline); current(args.documentId);
          var pixelOptions = { documentID: doc.id, sourceBounds: { left: source.left, top: source.top, right: source.right, bottom: source.bottom },
            targetSize: { width: Math.max(1, Math.round((source.right - source.left) * ratio)), height: Math.max(1, Math.round((source.bottom - source.top) * ratio)) },
            componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: false };
          // UXP distinguishes an omitted optional key from a key with undefined.
          if (args.layerId != null) pixelOptions.layerID = args.layerId;
          var pixelData = await ps.imaging.getPixels(pixelOptions);
          var data = pixelData.imageData;
          try {
            var pixels = await data.getData({ chunky: true }), comp = data.components;
            if (comp !== 3 && comp !== 4) throw new Error("不支持的预览像素格式");
            if (comp === 4) {
              var rgb = new Uint8Array(data.width * data.height * 3);
              for (var i = 0; i < data.width * data.height; i++) {
                var alpha = pixels[i * 4 + 3] / 255;
                for (var c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(pixels[i * 4 + c] * alpha + 255 * (1 - alpha));
              }
              pixels = rgb; comp = 3;
            }
            var png = encode.encodePNGFromRGB(data.width, data.height, pixels, comp);
            result = { layerId: args.layerId || null, width: data.width, height: data.height, sourceBounds: pixelData.sourceBounds || source, transparencyBackground: "white", capturedAt: new Date().toISOString(),
              image: { mimeType: "image/png", base64: encode.arrayBufferToBase64(png.buffer) } };
          } finally { if (data && data.dispose) data.dispose(); }
        }, { commandName: "LS Studio · 读取画布预览" });
      }
      current(args.documentId);
      return Object.assign({ ok: true, documentId: doc.id }, result);
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { createExecutor: createExecutor };
  if (!root || !root.PXD_CONTEXT || !root.PXD_CONTEXT.isPhotoshop) return;
  var ps = require("photoshop"), stopped = false, token = null, clientId = "ps_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  var execute = createExecutor(ps, root.psEncode, { readSelection: async function () { return (await root.PXD_CONTEXT.read()).selection; } });
  function base() { return (document.getElementById("baseUrl").value.trim() || "http://127.0.0.1:17880").replace(/\/+$/, ""); }
  async function request(route, body, hostToken) {
    var config = { method: body === undefined ? "GET" : "POST", headers: { "X-PXDLS-Agent": "1", "X-PXDLS-Host": hostToken || token || "" } };
    if (body !== undefined) { config.headers["Content-Type"] = "application/json"; config.body = JSON.stringify(body); }
    var timer, controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) config.signal = controller.signal;
    try {
      return await Promise.race([(async function () {
        var response = await fetch(base() + route, config), value = await response.json();
        if (!response.ok || !value.ok) throw new Error(value.error || "PS 连接失败"); return value;
      })(), new Promise(function (_, reject) { timer = setTimeout(function () { if (controller) controller.abort(); reject(new Error("PS 连接超时")); }, 18000); })]);
    } finally { clearTimeout(timer); }
  }
  async function loop() {
    while (!stopped) {
      try {
        if (!token) token = (await request("/photoshop/register", { clientId: clientId, version: String(require("uxp").host.version) })).hostToken;
        var ownerToken = token, response = await request("/photoshop/jobs?clientId=" + clientId);
        if (response.job && !stopped) {
          var job = response.job, result;
          try { result = await execute(job.tool, job.arguments, job.expiresAt); }
          catch (e) { result = { ok: false, error: String(e.message || e).slice(0, 600), code: e.code || "HOST_EXECUTION_FAILED" }; if (e.details) result.details = e.details; }
          await request("/photoshop/result", { clientId: clientId, id: job.id, result: result }, ownerToken);
        }
      } catch (e) {
        token = null;
        console.log("[ps.agent] " + String(e.message).slice(0, 300));
        await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      }
    }
  }
  var heartbeat = setInterval(function () { if (token) request("/photoshop/heartbeat", { clientId: clientId }).catch(function () {}); }, 10000);
  root.addEventListener("unload", function () { stopped = true; clearInterval(heartbeat); });
  document.getElementById("baseUrl").addEventListener("change", function () { token = null; });
  root.PXD_PS_AGENT = { execute: execute };
  loop();
})(typeof window === "undefined" ? null : window);
