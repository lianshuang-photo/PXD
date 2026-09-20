/* Production Photoshop boundary. No model-authored JavaScript or descriptors.
 * Receipts are capabilities in this runtime's ledger, never arbitrary layer IDs.
 */
(function () {
  "use strict";
  var pixels = require("./ps-pixels-014.js");
  var hostError = pixels.createHostError;
  function demand(condition, code, message) { if (!condition) throw hostError(code, message); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonical(value[key]); }).join(",") + "}";
    return JSON.stringify(value);
  }
  function keys(value, allowed, required) {
    demand(value && typeof value === "object" && !Array.isArray(value), "INVALID_INPUT", "请求参数必须是对象");
    demand(Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; }) && (required || []).every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); }), "INVALID_INPUT", "请求包含缺失或不支持的字段");
  }
  function integer(v) { return Number.isInteger(v) && v > 0; }
  function identifier(v) { return typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v); }
  function value(v) { return typeof v === "number" ? v : Number(v && (v._value != null ? v._value : v.value != null ? v.value : v)); }
  function validateRef(ref) {
    keys(ref, ["runtimeId", "documentToken", "documentId", "historyStateId", "width", "height", "name"], ["runtimeId", "documentToken", "documentId", "historyStateId", "width", "height"]);
    demand(identifier(ref.runtimeId) && identifier(ref.documentToken) && integer(ref.documentId) && integer(ref.width) && integer(ref.height), "INVALID_INPUT", "文档引用无效");
    demand(Number.isInteger(ref.historyStateId) || typeof ref.historyStateId === "string" && ref.historyStateId.length > 0 && ref.historyStateId.length <= 128, "INVALID_INPUT", "文档引用缺少有效历史状态");
    demand(ref.name == null || typeof ref.name === "string" && ref.name.length <= 1000, "INVALID_INPUT", "文档名称无效");
  }
  function validateChanges(changes) {
    keys(changes, ["name", "opacity", "visible"]);
    demand(Object.keys(changes).length, "INVALID_INPUT", "至少选择一个图层属性");
    if (Object.prototype.hasOwnProperty.call(changes, "name")) demand(typeof changes.name === "string" && changes.name.length <= 1000, "INVALID_INPUT", "图层名称无效");
    if (Object.prototype.hasOwnProperty.call(changes, "opacity")) demand(typeof changes.opacity === "number" && Number.isFinite(changes.opacity) && changes.opacity >= 0 && changes.opacity <= 100, "INVALID_INPUT", "图层不透明度必须介于 0–100");
    if (Object.prototype.hasOwnProperty.call(changes, "visible")) demand(typeof changes.visible === "boolean", "INVALID_INPUT", "图层可见性无效");
  }
  function validate(tool, args) {
    var fields = { studio_capture: ["documentId", "scope"], studio_edit_layer: ["documentRef", "jobId", "mutationId", "layerId", "changes"], studio_apply_result: ["documentRef", "jobId", "mutationId", "image", "mask", "transform", "settings"], studio_rollback: ["receipt"] };
    demand(fields[tool], "INVALID_INPUT", "不支持的 Photoshop 生产请求");
    keys(args, fields[tool]);
    if (tool === "studio_capture") demand(integer(args.documentId) && ["selection", "document"].indexOf(args.scope) >= 0, "INVALID_INPUT", "必须明确文档与处理范围");
    else if (tool === "studio_rollback") demand(args.receipt && identifier(args.receipt.mutationId), "ROLLBACK_CONFLICT", "没有有效的修改回执");
    else {
      validateRef(args.documentRef);
      demand(identifier(args.jobId) && identifier(args.mutationId), "INVALID_INPUT", "任务或修改 ID 无效");
      if (tool === "studio_edit_layer") { demand(integer(args.layerId), "INVALID_INPUT", "图层 ID 无效"); validateChanges(args.changes); }
      else {
        keys(args.image, ["base64", "mimeType", "width", "height"], ["base64", "mimeType", "width", "height"]);
        demand(typeof args.image.base64 === "string" && args.image.base64.length <= 48 * 1024 * 1024 && ["image/png", "image/jpeg", "image/webp"].indexOf(args.image.mimeType) >= 0 && integer(args.image.width) && integer(args.image.height), "INVALID_INPUT", "生成图像无效");
        keys(args.transform, ["sourceBounds", "inputWidth", "inputHeight"], ["sourceBounds", "inputWidth", "inputHeight"]);
        var b = args.transform.sourceBounds;
        keys(b, ["left", "top", "right", "bottom"], ["left", "top", "right", "bottom"]);
        demand(Object.keys(b).every(function (key) { return Number.isInteger(b[key]); }) && b.left >= 0 && b.top >= 0 && b.right <= args.documentRef.width && b.bottom <= args.documentRef.height && b.right > b.left && b.bottom > b.top && args.transform.inputWidth === b.right - b.left && args.transform.inputHeight === b.bottom - b.top, "INVALID_INPUT", "源坐标与原始像素尺寸不匹配");
        pixels.dimensions(args.transform.inputWidth, args.transform.inputHeight);
        if (args.mask) {
          keys(args.mask, ["base64", "mimeType", "width", "height"], ["base64", "mimeType", "width", "height"]);
          demand(typeof args.mask.base64 === "string" && args.mask.base64.length <= 48 * 1024 * 1024 && args.mask.mimeType === "image/png" && args.mask.width === args.transform.inputWidth && args.mask.height === args.transform.inputHeight, "MASK_MISMATCH", "蒙版格式或尺寸与源选区不匹配");
        }
        if (args.settings) {
          keys(args.settings, ["autoApply", "groupResults", "returnType"]);
          ["autoApply", "groupResults"].forEach(function (key) { demand(args.settings[key] == null || typeof args.settings[key] === "boolean", "INVALID_INPUT", "回写设置无效"); });
          demand(args.settings.returnType == null || args.settings.returnType === "new-layer", "HOST_UNSUPPORTED", "生产回写只支持新建图层");
        }
      }
    }
  }
  function createStudioHost(ps, encode, options) {
    options = options || {};
    var development = typeof window !== "undefined" && window.PXD_RUNTIME && window.PXD_RUNTIME.channel === "development";
    var makeId = options.makeId || function () { return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); };
    var runtimeId = "runtime_" + makeId(), docs = new Map(), captures = [], captureBytes = 0, ledger = new Map(), tail = Promise.resolve(), circuitError = null;
    var captureLimit = options.captureByteLimit == null ? 64 * 1024 * 1024 : options.captureByteLimit;
    var now = options.now || function () { return new Date().toISOString(); };
    // Return a small diagnostic to the isolated development UI, never the native
    // error object (which can contain descriptors, pixels, paths, or credentials).
    function diagnose(error, stage, nativeError) {
      if (!development || error.details && error.details.photoshopDiagnostic) return error;
      var native = {}, message = nativeError && nativeError.message;
      if (nativeError && typeof nativeError.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(nativeError.name)) native.name = nativeError.name;
      if (nativeError && typeof nativeError.number === "number" && Number.isFinite(nativeError.number)) native.number = nativeError.number;
      if (nativeError && typeof nativeError.code === "number" && Number.isFinite(nativeError.code)) native.code = nativeError.code;
      if (nativeError && typeof nativeError.result === "number" && Number.isFinite(nativeError.result)) native.result = nativeError.result;
      if (typeof message === "string") {
        native.message = message.replace(/[\[{][\s\S]*$/, "[payload omitted]")
          .replace(/(?:data:|https?:\/\/|file:\/\/|\/Users\/|[A-Za-z]:\\)[^\s]*/gi, "[redacted]")
          .replace(/(?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "[quoted]")
          .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]")
          .replace(/[\r\n\t]+/g, " ").slice(0, 280);
      }
      error.details = Object.assign({}, error.details, { photoshopDiagnostic: { stage: stage, native: native } });
      var nativeNumber = native.number == null ? native.result : native.number;
      error.message += " [dev: " + stage + (nativeNumber == null ? "" : "; PS " + nativeNumber) + (native.message ? "; " + native.message : "") + "]";
      return error;
    }
    async function modal(operation, settings) {
      // UXP can reconstruct callback errors as plain native Errors. Keep our
      // original error locally so domain codes and recovery status survive.
      var callbackError;
      try {
        return await ps.core.executeAsModal(async function (context) {
          try { return await operation(context); }
          catch (error) { callbackError = error; throw error; }
        }, settings);
      } catch (error) { throw callbackError || error; }
    }
    function invalidate(event, descriptor) {
      var id = descriptor && (descriptor.documentID || descriptor.documentId);
      if (!id && descriptor && Array.isArray(descriptor._target)) { var t = descriptor._target.find(function (v) { return v._ref === "document" && v._id; }); id = t && t._id; }
      if (id) docs.delete(id); else docs.clear();
    }
    var lifecycle = Promise.resolve().then(function () {
      if (options.observeLifecycle) return options.observeLifecycle(invalidate);
      demand(ps.action && typeof ps.action.addNotificationListener === "function", "HOST_UNSUPPORTED", "此 Photoshop 宿主缺少文档打开/关闭通知，无法安全绑定源文档");
      return ps.action.addNotificationListener(["open", "close"], invalidate);
    }).then(function () { return null; }, function (error) { return pixels.isHostError(error) ? error : diagnose(hostError("HOST_UNSUPPORTED", "无法监听 Photoshop 文档生命周期"), "lifecycle", error); });
    function syncDocuments() {
      var open = Array.from(ps.app.documents || []);
      docs.forEach(function (_, id) { if (!open.some(function (d) { return d.id === id; })) docs.delete(id); });
      open.forEach(function (doc) {
        var old = docs.get(doc.id);
        if (!old || old.doc !== doc) docs.set(doc.id, { doc: doc, token: "document_" + makeId() });
      }); return open;
    }
    function active(id, code) {
      var open = syncDocuments(), doc = ps.app.activeDocument;
      demand(doc && open.some(function (d) { return d.id === doc.id; }) && doc.id === id, code || "DOCUMENT_CONFLICT", "源文档已关闭或活动文档已切换，请重新捕获"); return doc;
    }
    function history(doc) {
      var state;
      try { state = doc.activeHistoryState.id; } catch (_) {}
      demand(Number.isInteger(state) || typeof state === "string" && !!state, "HOST_UNSUPPORTED", "无法读取 Photoshop 文档历史状态"); return state;
    }
    function reference(doc) { return { runtimeId: runtimeId, documentToken: docs.get(doc.id).token, documentId: doc.id, historyStateId: history(doc), width: value(doc.width), height: value(doc.height), name: String(doc.title || doc.name || "").slice(0, 1000) }; }
    function refKey(ref) { var r = copy(ref); delete r.name; return canonical(r); }
    function guard(ref, expectedHistory, code) {
      var doc = active(ref.documentId, code);
      demand(ref.runtimeId === runtimeId && docs.get(doc.id).token === ref.documentToken && value(doc.width) === ref.width && value(doc.height) === ref.height && history(doc) === expectedHistory, code || "DOCUMENT_CONFLICT", "源文档身份或历史状态已变化，请重新捕获后操作"); return doc;
    }
    function deadlineCheck(deadline) { demand(!deadline || Date.now() < deadline, "REQUEST_EXPIRED", "请求已过期，未继续修改 Photoshop"); }
    async function batchPlay(commands) {
      var responses = await ps.action.batchPlay(commands, {});
      var failedIndex = Array.isArray(responses) ? responses.findIndex(function (r) { return !r || r._obj === "error" || typeof r.result === "number" && r.result < 0; }) : -1;
      if (!Array.isArray(responses) || responses.length !== commands.length || failedIndex >= 0) throw diagnose(hostError("HOST_EXECUTION_FAILED", "Photoshop 返回命令错误，已取消本次事务"), "batch-play", failedIndex >= 0 ? responses[failedIndex] : null);
      return responses;
    }
    var capture = (options.createCapture || require("./ps-capture-014.js").createProductionCapture)(ps, encode, options);
    var placement = (options.createReturn || require("./ps-return-014.js").createProductionReturn)(ps, encode, Object.assign({}, options, { batchPlay: batchPlay }));
    function layers(doc) {
      var result = [];
      function walk(items) { Array.from(items || []).forEach(function (layer) { result.push(layer); if (layer.layers && layer.layers.length) walk(layer.layers); }); }
      walk(doc.layers); return result;
    }
    function find(doc, id, code) { var layer = layers(doc).find(function (l) { return l.id === id; }); demand(layer, code || "DOCUMENT_CONFLICT", "目标图层不存在或已被删除"); return layer; }
    function properties(layer) {
      var props = { name: String(layer.name), opacity: value(layer.opacity), visible: layer.visible };
      demand(Number.isFinite(props.opacity) && typeof props.visible === "boolean", "HOST_UNSUPPORTED", "无法可靠读取图层属性"); return props;
    }
    function sameProperties(a, b, tolerance) { return a.name === b.name && Math.abs(a.opacity - b.opacity) <= (tolerance || 0.000001) && a.visible === b.visible; }
    function verifyProperties(actual, expected, tolerance, message) {
      if (sameProperties(actual, expected, tolerance)) return;
      var error = hostError("HOST_EXECUTION_FAILED", message);
      if (development) {
        var fields = [];
        if (actual.name !== expected.name) fields.push("name");
        if (Math.abs(actual.opacity - expected.opacity) > (tolerance || 0.000001)) fields.push("opacity");
        if (actual.visible !== expected.visible) fields.push("visible");
        // Layer names and other request text never enter this diagnostic.
        var diagnostic = { stage: "property-verification", fields: fields };
        var summary = "mismatch=" + fields.join(",");
        if (fields.indexOf("opacity") >= 0) {
          diagnostic.opacity = { expected: expected.opacity, actual: actual.opacity };
          summary += "; opacity expected=" + expected.opacity + " actual=" + actual.opacity;
        }
        error.details = { photoshopDiagnostic: diagnostic };
        error.message += " [dev: property-verification; " + summary + "]";
      }
      throw error;
    }
    async function setProperties(doc, layerId, changes) {
      var target = [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: doc.id }], commands = [];
      // Photoshop's layer setter can accept a combined descriptor but only apply
      // one property. Match the DOM's separate setters inside our one transaction.
      if (changes.name != null) commands.push({ _obj: "set", _target: target, to: { _obj: "layer", name: changes.name }, _options: { dialogOptions: "dontDisplay" } });
      if (changes.opacity != null) commands.push({ _obj: "set", _target: target, to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: changes.opacity } }, _options: { dialogOptions: "dontDisplay" } });
      if (changes.visible != null) commands.push({ _obj: changes.visible ? "show" : "hide", null: target, _options: { dialogOptions: "dontDisplay" } });
      if (commands.length) await batchPlay(commands);
    }
    function remember(ref, result) {
      var maskBytes = result.maskPixels ? result.maskPixels.length : 0;
      demand(maskBytes <= captureLimit, "IMAGE_TOO_LARGE", "本次选区超过宿主蒙版缓存上限");
      var record = { refKey: refKey(ref), transform: copy(result.transform), scope: result.scope, maskHash: result.mask ? pixels.sha256(result.mask.base64) : null, maskPixels: result.maskPixels ? new Uint8Array(result.maskPixels) : null };
      var duplicate = captures.findIndex(function (v) { return v.refKey === record.refKey && canonical(v.transform) === canonical(record.transform) && v.maskHash === record.maskHash; });
      if (duplicate >= 0) { captureBytes -= captures[duplicate].maskPixels ? captures[duplicate].maskPixels.length : 0; captures.splice(duplicate, 1); }
      while (captures.length >= 64 || captureBytes + maskBytes > captureLimit) { var removed = captures.shift(); captureBytes -= removed.maskPixels ? removed.maskPixels.length : 0; }
      captures.push(record); captureBytes += maskBytes;
    }
    function sourceFor(args) {
      var eligible = captures.filter(function (v) { return v.refKey === refKey(args.documentRef); });
      demand(eligible.length, "CONTEXT_EXPIRED", "源捕获已过期或来自另一个插件运行实例，请重新捕获");
      if (!args.transform) return eligible[eligible.length - 1];
      eligible = eligible.filter(function (v) { return canonical(v.transform) === canonical(args.transform); });
      demand(eligible.length, "SOURCE_MISMATCH", "回写坐标不是该源文档实际捕获的范围");
      var hash = args.mask ? pixels.sha256(args.mask.base64) : null;
      var found = eligible.find(function (v) { return v.maskHash === hash && (v.scope !== "selection" || !!args.mask); });
      demand(found, args.mask ? "MASK_MISMATCH" : "MASK_REQUIRED", "必须使用本次捕获的真实选区蒙版，未进行矩形或整图回退"); return found;
    }
    async function transaction(ref, expectedHistory, label, deadline, operation, conflictCode) {
      demand(ps.core && ps.core.executeAsModal, "HOST_UNSUPPORTED", "Photoshop 模态事务接口不可用");
      var result, stage = "modal-entry";
      try { await modal(async function (context) {
        stage = "context-guard";
        deadlineCheck(deadline);
        demand(!context || !context.isCancelled, "HOST_CANCELLED", "Photoshop 已取消本次操作");
        stage = "document-guard";
        var doc = guard(ref, expectedHistory, conflictCode), control = context && context.hostControl;
        demand(control && control.suspendHistory && control.resumeHistory, "HOST_UNSUPPORTED", "Photoshop 历史事务接口不可用，未修改文档");
        stage = "history-read-before";
        var preHistory = history(doc), suspension, committed = false;
        stage = "history-suspend";
        suspension = await control.suspendHistory({ documentID: doc.id, name: label });
        demand(suspension != null, "HOST_EXECUTION_FAILED", "Photoshop 未建立历史事务");
        try {
          stage = "operation";
          var details = await operation(doc);
          stage = "commit-guard";
          deadlineCheck(deadline);
          demand(!context.isCancelled, "HOST_CANCELLED", "Photoshop 已取消本次操作，正在恢复事务");
          active(doc.id, conflictCode);
          stage = "history-commit";
          await control.resumeHistory(suspension, true); committed = true;
          stage = "history-read-after";
          var postHistory = history(doc);
          result = Object.assign({ preHistoryStateId: preHistory, postHistoryStateId: postHistory }, details);
          stage = "modal-exit";
        } catch (error) {
          var failedStage = stage;
          if (!committed) {
            try { stage = "history-rollback"; await control.resumeHistory(suspension, false); }
            catch (recoveryError) { circuitError = diagnose(hostError("HOST_RECOVERY_REQUIRED", "Photoshop 无法确认本次事务已恢复；已停止后续自动写入，请检查文档", { mutationMayHaveApplied: true }), stage, recoveryError); throw circuitError; }
          } else { circuitError = diagnose(hostError("HOST_RECOVERY_REQUIRED", "Photoshop 已提交但无法确认回执；已停止后续自动写入，请检查文档", { mutationMayHaveApplied: true }), failedStage, error); throw circuitError; }
          throw diagnose(pixels.isHostError(error) ? error : hostError("HOST_EXECUTION_FAILED", "Photoshop 执行失败，本次历史事务已恢复"), failedStage, error);
        }
      }, { commandName: label }); }
      catch (error) {
        if (result && !circuitError) circuitError = hostError("HOST_RECOVERY_REQUIRED", "Photoshop 模态退出失败但修改可能已经提交；已停止后续自动写入", { mutationMayHaveApplied: true });
        throw diagnose(circuitError || (pixels.isHostError(error) ? error : hostError("HOST_EXECUTION_FAILED", "Photoshop 无法执行本次模态操作")), stage, error);
      }
      return result;
    }
    function queued(fn) { var promise = tail.then(fn); tail = promise.catch(function () {}); return promise; }
    async function mutate(tool, args, deadline) {
      var fingerprint = pixels.sha256(canonical({ tool: tool, args: args })), old = ledger.get(args.mutationId);
      if (old) { demand(old.fingerprint === fingerprint, "MUTATION_CONFLICT", "同一个修改 ID 不能用于不同操作"); var previous = await old.promise; return old.receipt ? { ok: true, receipt: copy(old.receipt) } : copy(previous); }
      demand(ledger.size < 256, "SESSION_LIMIT", "当前插件会话已达修改回执上限，请先完成撤销检查再重新载入");
      var entry = { fingerprint: fingerprint, receipt: null, issued: null, promise: null };
      entry.promise = queued(async function () {
        if (circuitError) throw circuitError;
        deadlineCheck(deadline); guard(args.documentRef, args.documentRef.historyStateId); var source = sourceFor(args), prepared = null, details;
        try {
          if (tool === "studio_apply_result") prepared = await placement.prepare(args, source);
          details = await transaction(args.documentRef, args.documentRef.historyStateId, tool === "studio_edit_layer" ? "LS Studio · 修改图层属性" : "LS Studio · 回写生成结果", deadline, async function (doc) {
            if (tool === "studio_apply_result") return placement.placeInModal(doc, args, source, prepared);
            var before = properties(find(doc, args.layerId)), expected = Object.assign({}, before, args.changes);
            await setProperties(doc, args.layerId, args.changes);
            var after = properties(find(doc, args.layerId));
            // Photoshop can quantize opacity to an 8-bit channel. Record the actual
            // returned value; rollback guards compare that value without tolerance.
            verifyProperties(after, expected, 50 / 255 + 0.000001, "Photoshop 图层属性未达到请求状态");
            return { createdLayerIds: [], modifiedLayers: [{ layerId: args.layerId, before: before, after: after }] };
          });
        } finally { if (prepared) { try { await placement.cleanup(prepared); } catch (_) { /* Temporary-file cleanup cannot turn a committed document write into a retry. */ } } }
        entry.receipt = Object.assign({ mutationId: args.mutationId, jobId: args.jobId, documentRef: copy(args.documentRef), operation: tool, rollbackStatus: "available", createdAt: now() }, details);
        entry.issued = canonical(entry.receipt);
        return { ok: true, receipt: copy(entry.receipt) };
      });
      // Register before the first await so concurrent transport retries share this promise.
      ledger.set(args.mutationId, entry); return copy(await entry.promise);
    }
    async function rollback(args, deadline) {
      var entry = ledger.get(args.receipt.mutationId);
      demand(entry && entry.receipt && (canonical(args.receipt) === entry.issued || canonical(args.receipt) === canonical(entry.receipt)), "ROLLBACK_CONFLICT", "修改回执未知、已过期或被替换，不能据此删除图层");
      if (entry.receipt.rollbackStatus === "rolled-back") return { ok: true, receipt: copy(entry.receipt) };
      if (circuitError) throw circuitError;
      var receipt = entry.receipt;
      var details = await transaction(receipt.documentRef, receipt.postHistoryStateId, "LS Studio · 撤销本次修改", deadline, async function (doc) {
        receipt.createdLayerIds.forEach(function (id) { find(doc, id, "ROLLBACK_CONFLICT"); });
        receipt.modifiedLayers.forEach(function (change) { demand(sameProperties(properties(find(doc, change.layerId, "ROLLBACK_CONFLICT")), change.after), "ROLLBACK_CONFLICT", "目标图层已有后续修改，未覆盖用户编辑"); });
        if (receipt.createdLayerIds.length) await batchPlay(receipt.createdLayerIds.map(function (id) { return { _obj: "delete", _target: [{ _ref: "layer", _id: id }, { _ref: "document", _id: doc.id }], _options: { dialogOptions: "dontDisplay" } }; }));
        for (var i = 0; i < receipt.modifiedLayers.length; i++) {
          var change = receipt.modifiedLayers[i]; await setProperties(doc, change.layerId, change.before);
          verifyProperties(properties(find(doc, change.layerId)), change.before, 0.000001, "原有图层属性未能恢复");
        }
        demand(receipt.createdLayerIds.every(function (id) { return !layers(doc).some(function (layer) { return layer.id === id; }); }), "HOST_EXECUTION_FAILED", "本次创建的图层未能撤销"); return {};
      }, "ROLLBACK_CONFLICT");
      entry.receipt = Object.assign({}, receipt, { rollbackStatus: "rolled-back", rolledBackAt: now(), rollbackHistoryStateId: details.postHistoryStateId });
      return { ok: true, receipt: copy(entry.receipt) };
    }
    async function executeRequest(tool, args, deadline) {
      validate(tool, args); args = copy(args);
      var unsupported = await lifecycle; if (unsupported) throw unsupported;
      deadlineCheck(deadline);
      if (tool === "studio_edit_layer" || tool === "studio_apply_result") return mutate(tool, args, deadline);
      return queued(async function () {
        deadlineCheck(deadline);
        if (tool === "studio_rollback") return rollback(args, deadline);
        var result;
        await modal(async function () {
          deadlineCheck(deadline); var doc = active(args.documentId), ref = reference(doc), captured = await capture(doc, args.scope);
          guard(ref, ref.historyStateId); deadlineCheck(deadline); remember(ref, captured);
          delete captured.maskPixels; result = Object.assign({ ok: true, documentRef: ref }, captured);
        }, { commandName: "LS Studio · 捕获生产上下文" }); return result;
      });
    }
    async function execute(tool, args, deadline) {
      try { return await executeRequest(tool, args, deadline); }
      catch (error) { throw diagnose(pixels.isHostError(error) ? error : hostError("HOST_EXECUTION_FAILED", "Photoshop 无法完成本次请求"), "request", error); }
    }
    return { execute: execute, runtimeId: runtimeId };
  }
  module.exports = { createStudioHost: createStudioHost, hostError: hostError };
})();
