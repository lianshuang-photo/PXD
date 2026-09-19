/* Shared professional workspace. The UI owns unsaved edits, the service owns
 * revisions/jobs/assets. Polling is read-only and never resumes an execution. */
(function (root) {
  "use strict";
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function error(code, message, details) { var value = new Error(message); value.code = code; if (details) value.details = details; return value; }
  function requireValue(ok, code, message) { if (!ok) throw error(code, message); }
  function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id); }
  function baseFor(location, configured) {
    if (location && /^https?:$/.test(location.protocol) && /^\/ui(?:\/|$)/.test(location.pathname || "")) return location.origin;
    return String(configured || "http://127.0.0.1:17881").replace(/\/+$/, "");
  }
  function base64(bytes) {
    var chunks = []; for (var i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return btoa(chunks.join(""));
  }
  function createTransport(options) {
    var fetchImpl = options.fetchImpl || fetch, base = baseFor(options.location, options.base);
    async function call(operation, args) {
      var response;
      try { response = await fetchImpl(base + "/studio/call", { method: "POST", headers: { "Content-Type": "application/json", "X-PXDLS-Agent": "1" }, body: JSON.stringify({ operation: operation, arguments: args || {} }) }); }
      catch (_) { throw error("NETWORK_ERROR", "连接中断。提交结果尚未确认，请先刷新任务；重试会沿用原请求编号。"); }
      var body;
      try { body = await response.json(); } catch (_) { throw error("INVALID_RESPONSE", "服务未返回有效结果，请刷新任务核对状态。"); }
      if (!response.ok || !body || body.ok !== true) {
        var detail = body && body.error, failure = error(detail && detail.code || body && body.code || "SERVICE_ERROR", detail && detail.message || (typeof detail === "string" ? detail : "工作区请求失败"), detail && detail.details || body && body.details);
        failure.status = response.status; throw failure;
      }
      return body.value;
    }
    async function readAsset(assetId) {
      requireValue(validId(assetId), "INVALID_INPUT", "资产编号无效");
      var response = await fetchImpl(base + "/studio/assets/" + encodeURIComponent(assetId), { headers: { "X-PXDLS-Agent": "1" } });
      requireValue(response.ok, "ASSET_UNAVAILABLE", "无法读取这份图像资产");
      var mime = String(response.headers.get("content-type") || "").split(";")[0];
      requireValue(["image/png", "image/jpeg", "image/webp"].indexOf(mime) >= 0, "INVALID_IMAGE", "预览资产格式不受支持");
      var advertised = Number(response.headers.get("content-length") || 0);
      requireValue(!advertised || advertised <= 32 * 1024 * 1024, "IMAGE_TOO_LARGE", "预览图像超过 32 MiB");
      var bytes = new Uint8Array(await response.arrayBuffer());
      requireValue(bytes.length && bytes.length <= 32 * 1024 * 1024, "IMAGE_TOO_LARGE", "预览图像为空或超过 32 MiB");
      return "data:" + mime + ";base64," + base64(bytes);
    }
    return { call: call, readAsset: readAsset, base: base };
  }
  function createController(options) {
    var transport = options.transport, storage = options.storage, storageKey = "pxdls.studio.pending:" + (transport.base || "test"), listeners = [], disposed = false, epoch = 0, localVersion = 0, refreshPromise = null;
    var idFactory = options.makeId || function () { return "ui_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); };
    var state = { discovery: null, drafts: [], draft: null, form: { params: {}, context: null }, dirty: false, conflict: null, jobs: [], selectedJobId: null, observed: { document: null, layers: [], nextOffset: null }, busy: false, error: null, notice: "", pendingRun: null, pendingPlacements: {}, recipes: { items: [], total: 0, nextOffset: null, query: "", selected: null, values: {}, userText: "", loading: false, error: null } }, recipeSequence = 0;
    try {
      var pending = storage && JSON.parse(storage.getItem(storageKey) || "null");
      if (pending && pending.run && validId(pending.run.draftId) && validId(pending.run.requestId) && Number.isInteger(pending.run.expectedRevision)) state.pendingRun = pending.run;
      if (pending && pending.placements && typeof pending.placements === "object") Object.keys(pending.placements).slice(0, 64).forEach(function (jobId) { var p = pending.placements[jobId]; if (validId(jobId) && p && validId(p.resultId) && validId(p.requestId)) state.pendingPlacements[jobId] = { jobId: jobId, resultId: p.resultId, requestId: p.requestId }; });
    } catch (_) {}
    function ensureActive() { requireValue(!disposed, "DISPOSED", "工作区连接已切换，未继续执行旧连接上的操作"); }
    function serviceCall(operation, args) { ensureActive(); return transport.call(operation, args); }
    function persist() { try { if (storage) storage.setItem(storageKey, JSON.stringify({ run: state.pendingRun, placements: state.pendingPlacements })); } catch (_) {} }
    function snapshot() { return clone(state); }
    function emit() { if (!disposed) listeners.forEach(function (fn) { try { fn(snapshot()); } catch (_) {} }); }
    function failure(e) {
      state.error = { code: e.code || "UI_ERROR", message: e.message || "操作失败" };
      if (e.code === "REVISION_CONFLICT" && e.details && e.details.current) state.conflict = { current: clone(e.details.current), reason: "revision" };
      emit(); return e;
    }
    function active() { ensureActive(); requireValue(state.draft, "DRAFT_REQUIRED", "先新建或选择一份共享草稿"); return state.draft; }
    function noConflict() { requireValue(!state.conflict, "REVISION_CONFLICT", "Agent 或另一界面更新了这份草稿。请重新载入，或将本地内容另存为新草稿。"); }
    function noDirty() { requireValue(!state.dirty, "UNSAVED_CHANGES", "当前草稿有未保存的修改，请先保存、另存或重新载入。"); }
    function setDraft(draft, preserveLocal) {
      state.draft = clone(draft);
      if (!preserveLocal) { state.form = { params: clone(draft.params || {}), context: clone(draft.context) }; state.dirty = false; state.conflict = null; localVersion++; }
      var index = state.drafts.findIndex(function (d) { return d.draftId === draft.draftId; });
      if (index < 0) state.drafts.unshift(clone(draft)); else state.drafts[index] = clone(draft);
    }
    function putJob(job) {
      var index = state.jobs.findIndex(function (j) { return j.jobId === job.jobId; });
      if (index < 0) state.jobs.unshift(clone(job)); else state.jobs[index] = clone(job);
      if (!state.selectedJobId) state.selectedJobId = job.jobId;
    }
    async function write(fn) {
      requireValue(!disposed, "DISPOSED", "工作区连接已切换");
      requireValue(!state.busy, "UI_BUSY", "上一项操作仍在进行");
      state.busy = true; state.error = null; state.notice = ""; epoch++; emit();
      try { return await fn(); } catch (e) { throw failure(e); }
      finally { state.busy = false; epoch++; emit(); }
    }
    async function refresh() {
      if (refreshPromise) return refreshPromise;
      var observedEpoch = epoch;
      refreshPromise = Promise.all([serviceCall("discover", {}), serviceCall("listDrafts", {}), serviceCall("listJobs", {})]).then(function (values) {
        if (disposed || observedEpoch !== epoch) return snapshot();
        state.discovery = clone(values[0]); state.drafts = clone(values[1]); state.jobs = clone(values[2]);
        if (state.draft) {
          var latest = state.drafts.find(function (d) { return d.draftId === state.draft.draftId; });
          if (latest && latest.revision > state.draft.revision) {
            if (state.dirty) state.conflict = { current: clone(latest), reason: "external" };
            else { setDraft(latest, false); state.notice = "已同步 Agent / 其他界面的最新草稿"; }
          }
        } else if (state.drafts.length) setDraft(state.drafts[0], false);
        if (state.pendingRun) {
          var submitted = state.jobs.find(function (j) { return j.requestId === state.pendingRun.requestId; });
          if (submitted) { state.selectedJobId = submitted.jobId; state.pendingRun = null; persist(); state.notice = "已找回提交的任务"; }
        }
        Object.keys(state.pendingPlacements).forEach(function (jobId) {
          var job = state.jobs.find(function (j) { return j.jobId === jobId; });
          if (job && job.placement && ["applied", "rolled-back", "rollback-conflict"].indexOf(job.placement.status) >= 0) delete state.pendingPlacements[jobId];
        }); persist();
        if (!state.selectedJobId && state.jobs.length) state.selectedJobId = state.jobs[0].jobId;
        emit(); return snapshot();
      }).catch(function (e) { if (!disposed && observedEpoch === epoch) failure(e); throw e; }).finally(function () { refreshPromise = null; });
      return refreshPromise;
    }
    async function createDraft(capabilityId, preserve) {
      return write(async function () {
        if (!preserve) noDirty();
        var version = localVersion, form = preserve ? clone(state.form) : { params: {}, context: null };
        var draft = await serviceCall("createDraft", { capabilityId: capabilityId, params: form.params, context: form.context, source: "ui" });
        setDraft(draft, preserve && localVersion !== version); state.notice = "已建立共享草稿"; return clone(draft);
      });
    }
    function editParams(patch) { active(); state.form.params = Object.assign({}, state.form.params, clone(patch)); state.dirty = true; localVersion++; state.error = null; emit(); }
    function editContext(patch) { active(); requireValue(state.form.context, "CONTEXT_REQUIRED", "请先捕获明确的选区或整图范围"); state.form.context = Object.assign({}, state.form.context, clone(patch)); state.dirty = true; localVersion++; state.error = null; emit(); }
    async function saveInternal() {
      var draft = active(); noConflict();
      if (!state.dirty) return clone(draft);
      var version = localVersion, updated = await serviceCall("updateDraft", { draftId: draft.draftId, expectedRevision: draft.revision, params: clone(state.form.params), context: clone(state.form.context), source: "ui" });
      setDraft(updated, version !== localVersion); state.notice = "已保存共享草稿 · revision " + updated.revision; return clone(updated);
    }
    async function loadDraft(draftId, discard) {
      return write(async function () { if (!discard) noDirty(); var draft = await serviceCall("getDraft", { draftId: draftId }); setDraft(draft, false); state.notice = "已读取最新共享版本"; return clone(draft); });
    }
    async function observeLayersInternal() {
      var doc = await serviceCall("observe", { tool: "photoshop_get_document", arguments: {} });
      requireValue(doc && doc.open && doc.document, "NO_DOCUMENT", "Photoshop 没有活动文档");
      var result = await serviceCall("observe", { tool: "photoshop_list_layers", arguments: { documentId: doc.document.id, limit: 200, offset: 0 } });
      state.observed = { document: clone(doc.document), layers: clone(result.layers || []), nextOffset: result.nextOffset == null ? null : result.nextOffset }; emit(); return clone(state.observed);
    }
    function selectLayer(layerId) {
      var draft = active(), context = state.form.context, observed = state.observed;
      requireValue(draft.capabilityId === "ps.layer.update" && context && observed.document && context.documentRef.documentId === observed.document.id && context.documentRef.historyStateId === observed.document.historyStateId && observed.layers.some(function (layer) { return layer.id === layerId; }), "LAYER_CONTEXT_CONFLICT", "请捕获当前文档并刷新真实图层列表后选择图层");
      editParams({ layerId: layerId });
    }
    async function capture(scope) {
      return write(async function () {
        active(); noConflict(); requireValue(["selection", "document"].indexOf(scope) >= 0, "INVALID_INPUT", "必须明确选区或整图范围");
        var doc = await serviceCall("observe", { tool: "photoshop_get_document", arguments: {} });
        requireValue(doc && doc.open && doc.document, "NO_DOCUMENT", "Photoshop 没有活动文档");
        var captured = await serviceCall("capture", { documentId: doc.document.id, scope: scope }), old = state.form.context;
        if (old) { captured.refs = clone(old.refs || []); captured.preserve = clone(old.preserve || []); captured.settings = clone(old.settings || captured.settings); }
        if (state.draft.capabilityId === "ps.layer.update" && (!old || ["runtimeId", "documentToken", "documentId"].some(function (key) { return old.documentRef[key] !== captured.documentRef[key]; }))) {
          // Photoshop layer IDs are only meaningful within one document open.
          // Persist an unbound target rather than reusing A's layer ID in B.
          state.form.params = Object.assign({}, state.form.params, { layerId: null, changes: {} });
        }
        state.form.context = captured; state.dirty = true; localVersion++; state.notice = "已捕获 " + (scope === "selection" ? "真实选区" : "明确整图") + "，运行将使用这份快照";
        if (state.draft.capabilityId === "ps.layer.update") await observeLayersInternal(); return clone(captured);
      });
    }
    async function importReference(input, role) {
      return write(async function () {
        active(); noConflict(); requireValue(state.form.context, "CONTEXT_REQUIRED", "请先捕获处理范围，再加入参考图");
        requireValue((state.form.context.refs || []).length < 16, "REFERENCE_LIMIT", "最多加入 16 张参考图");
        requireValue(["reference", "identity", "style", "structure"].indexOf(role || "reference") >= 0, "INVALID_INPUT", "参考图用途无效");
        var asset = await serviceCall("importAsset", input), refs = (state.form.context.refs || []).concat([{ assetId: asset.assetId, role: role || "reference" }]);
        editContext({ refs: refs }); state.notice = "参考图已存入共享资产"; return clone(asset);
      });
    }
    async function submitRun(input) {
      ensureActive();
      state.pendingRun = clone(input); persist(); emit();
      try {
        var response = await serviceCall("run", input), job = response.job;
        requireValue(job && job.jobId, "INVALID_RESPONSE", "服务未返回任务编号，请先刷新任务核对");
        putJob(job); state.selectedJobId = job.jobId; state.pendingRun = null; persist(); state.notice = response.duplicate ? "已找回原任务，没有重复运行" : "任务已提交"; return clone(job);
      } catch (e) { if (e.status >= 400 && e.status < 500 || e.code === "REVISION_CONFLICT") { state.pendingRun = null; persist(); } throw e; }
    }
    async function run() {
      return write(async function () {
        var draft = active(); noConflict();
        requireValue(!state.pendingRun, "SUBMISSION_UNCERTAIN", "先刷新任务或重试原提交，不能创建另一个可能重复的任务");
        requireValue(state.discovery && state.discovery.photoshop && state.discovery.photoshop.connected, "HOST_UNAVAILABLE", "Photoshop 尚未连接");
        if (draft.capabilityId === "image.edit") requireValue(state.discovery.provider && state.discovery.provider.configured, "PROVIDER_NOT_CONFIGURED", "图像服务尚未配置");
        if (draft.capabilityId === "ps.layer.update") {
          await observeLayersInternal(); var layerId = state.form.params.layerId, observed = state.observed, context = state.form.context;
          if (context && observed.document.id === context.documentRef.documentId && observed.document.historyStateId === context.documentRef.historyStateId && Number.isInteger(layerId) && layerId > 0 && !observed.layers.some(function (layer) { return layer.id === layerId; })) {
            var observedLayer = await serviceCall("observe", { tool: "photoshop_get_layer", arguments: { documentId: observed.document.id, layerId: layerId } });
            if (observedLayer && observedLayer.layer && observedLayer.layer.id === layerId) observed.layers.push(clone(observedLayer.layer));
          }
          requireValue(context && observed.document.id === context.documentRef.documentId && observed.document.historyStateId === context.documentRef.historyStateId && observed.layers.some(function (layer) { return layer.id === layerId; }), "LAYER_CONTEXT_CONFLICT", "图层或文档已变化，请重新捕获后选择真实图层");
        }
        await saveInternal(); requireValue(!state.dirty, "DRAFT_CHANGED", "保存期间又有本地修改，请再次运行以使用最新内容");
        return submitRun({ draftId: state.draft.draftId, expectedRevision: state.draft.revision, requestId: idFactory(), source: "ui" });
      });
    }
    async function apply(jobId, resultId) {
      return write(async function () {
        var job = state.jobs.find(function (j) { return j.jobId === jobId; });
        requireValue(job && job.status === "succeeded" && job.results.some(function (r) { return r.resultId === resultId; }), "RESULT_REQUIRED", "请选择成功任务中的候选图");
        var placement = job.placement || { status: "not-requested" };
        if (placement.status === "applied") { requireValue(placement.receipt && placement.receipt.resultId === resultId, "PLACEMENT_CONFLICT", "这项任务已经回贴了其他候选图"); return clone(job); }
        requireValue(["not-requested", "failed"].indexOf(placement.status) >= 0, "PLACEMENT_CONFLICT", "这项回贴尚未确认、已撤销或存在冲突，请先核对记录");
        var pending = state.pendingPlacements[jobId];
        requireValue(!pending || pending.resultId === resultId, "PLACEMENT_CONFLICT", "上一张候选图的回贴尚未确认，请先刷新任务");
        var input = pending || { jobId: jobId, resultId: resultId, requestId: idFactory() }; state.pendingPlacements[jobId] = input; persist();
        try {
          var updated = await serviceCall("apply", input); putJob(updated); delete state.pendingPlacements[jobId]; persist();
          if (updated.placement && updated.placement.status === "applied") state.notice = "候选图已回贴为新图层";
          else { state.notice = ""; state.error = clone(updated.placement && updated.placement.error || { code: "PLACEMENT_CONFLICT", message: "回贴没有完成，请核对任务中的 Photoshop 状态。" }); }
          return clone(updated);
        }
        catch (e) { if (e.status >= 400 && e.status < 500) { delete state.pendingPlacements[jobId]; persist(); } throw e; }
      });
    }
    async function cancel(jobId) {
      // Cancellation has its own durable operation; it is never a new generation.
      epoch++;
      try { var job = await serviceCall("cancel", { jobId: jobId }); putJob(job); state.notice = job.status === "cancelled" ? (job.snapshot && job.snapshot.capabilityId === "ps.layer.update" ? "任务已取消；若宿主已经开始修改，请核对回执后撤销。" : "任务已取消；迟到结果不会自动回贴") : "任务已结束，状态已更新"; epoch++; emit(); return clone(job); }
      catch (e) { throw failure(e); }
    }
    async function rollback(jobId) {
      return write(async function () {
        var job = state.jobs.find(function (j) { return j.jobId === jobId; });
        if (job && job.placement && job.placement.status === "rolled-back") return clone(job);
        requireValue(job && job.placement && job.placement.status === "applied", "ROLLBACK_CONFLICT", "这项任务没有可以安全撤销的修改回执");
        var updated = await serviceCall("rollback", { jobId: jobId }); putJob(updated);
        if (updated.placement && updated.placement.status === "rolled-back") state.notice = "已按任务回执撤销本次修改";
        else { state.notice = ""; state.error = clone(updated.placement && updated.placement.error || { code: "ROLLBACK_CONFLICT", message: "撤销未被 Photoshop 确认；后续编辑已保留，请核对任务回执。" }); }
        return clone(updated);
      });
    }
    async function searchRecipes(query, append) {
      var sequence = ++recipeSequence, offset = append ? state.recipes.nextOffset : 0;
      state.recipes.query = String(query || ""); state.recipes.loading = true; state.recipes.error = null; emit();
      try {
        var result = await serviceCall("listRecipes", { q: state.recipes.query, offset: offset || 0, limit: 8 });
        if (disposed || sequence !== recipeSequence) return;
        state.recipes.items = append ? state.recipes.items.concat(clone(result.items)) : clone(result.items); state.recipes.total = result.total; state.recipes.nextOffset = result.nextOffset;
      } catch (e) { if (sequence === recipeSequence) state.recipes.error = "配方服务暂不可用；当前草稿仍可编辑和运行。"; throw e; }
      finally { if (sequence === recipeSequence) { state.recipes.loading = false; emit(); } }
    }
    async function selectRecipe(recipeId) {
      var sequence = ++recipeSequence; state.recipes.loading = true; state.recipes.error = null; emit();
      try {
        var recipe = await serviceCall("getRecipe", { recipeId: recipeId });
        if (disposed || sequence !== recipeSequence) return;
        var current = state.form.params.recipe, values = {};
        (recipe.parameters || []).forEach(function (p) { values[p.id] = p.defaultValue; });
        if (current && current.recipeId === recipe.recipeId && current.sourceHash === recipe.sourceHash) values = Object.assign(values, current.values);
        state.recipes.selected = clone(recipe); state.recipes.values = values; return clone(recipe);
      } catch (e) { if (sequence === recipeSequence) state.recipes.error = "无法读取所选配方，未修改草稿。"; throw e; }
      finally { if (sequence === recipeSequence) { state.recipes.loading = false; emit(); } }
    }
    function recipeValue(id, value) {
      var recipe = state.recipes.selected, parameter = recipe && recipe.parameters.find(function (p) { return p.id === id; });
      requireValue(parameter && Number.isFinite(value) && value >= parameter.min && value <= parameter.max, "INVALID_INPUT", "配方参数超出支持范围");
      state.recipes.values[id] = value; emit();
    }
    async function loadSelectedRecipe() {
      return write(async function () {
        var draft = active(), recipe = state.recipes.selected; noConflict();
        requireValue(draft.capabilityId === "image.edit" && recipe, "CAPABILITY_CONFLICT", "请在图像草稿中选择配方");
        requireValue(!recipe.requiresReferenceMapping, "REFERENCE_MAPPING_REQUIRED", "此配方需要显式参考图映射，当前界面暂不能载入");
        await saveInternal(); requireValue(!state.dirty, "DRAFT_CHANGED", "保存期间又有本地修改，请核对后再载入配方");
        var version = localVersion, updated = await serviceCall("loadRecipe", { recipeId: recipe.recipeId, draftId: state.draft.draftId, expectedRevision: state.draft.revision, values: clone(state.recipes.values), userText: state.recipes.userText, source: "ui" });
        setDraft(updated, localVersion !== version); state.notice = "已将配方载入共享草稿，尚未运行"; return clone(updated);
      });
    }
    return {
      snapshot: snapshot, subscribe: function (listener) { listeners.push(listener); listener(snapshot()); return function () { listeners = listeners.filter(function (v) { return v !== listener; }); }; },
      refresh: refresh, createDraft: function (capabilityId) { return createDraft(capabilityId, false); }, saveAsNew: function () { return createDraft(active().capabilityId, true); },
      loadDraft: function (draftId) { return loadDraft(draftId, false); }, reloadDraft: function () { return loadDraft(active().draftId, true); },
      editParams: editParams, editContext: editContext, save: function () { return write(saveInternal); }, capture: capture, importReference: importReference,
      refreshLayers: function () { return write(observeLayersInternal); }, selectLayer: selectLayer,
      loadMoreLayers: function () { return write(async function () { var doc = state.observed.document, offset = state.observed.nextOffset; requireValue(doc && offset != null, "NO_MORE_LAYERS", "没有更多图层"); var result = await serviceCall("observe", { tool: "photoshop_list_layers", arguments: { documentId: doc.id, limit: 200, offset: offset } }); state.observed.layers = state.observed.layers.concat(result.layers); state.observed.nextOffset = result.nextOffset; return clone(state.observed); }); },
      run: run, retryRun: function () { return write(function () { requireValue(state.pendingRun, "NO_PENDING_REQUEST", "没有待核对的提交"); return submitRun(clone(state.pendingRun)); }); }, cancel: cancel, apply: apply, rollback: rollback,
      selectJob: function (jobId) { state.selectedJobId = jobId; emit(); }, reportError: failure,
      loadRecipe: async function (recipe) { if (!state.draft) await createDraft("image.edit", false); requireValue(active().capabilityId === "image.edit", "CAPABILITY_CONFLICT", "请新建图像草稿后载入配方"); editParams(Object.assign({}, recipe.params || {}, { prompt: String(recipe.prompt || "") })); },
      searchRecipes: searchRecipes, selectRecipe: selectRecipe, setRecipeValue: recipeValue, setRecipeUserText: function (value) { state.recipes.userText = String(value); emit(); }, loadSelectedRecipe: loadSelectedRecipe,
      agentReference: function () { var draft = active(); noDirty(); noConflict(); return "请接着处理共享草稿 " + draft.draftId + "（revision " + draft.revision + "）。先用 studio_get_draft 读取当前版本，再基于同一份草稿继续；结果与任务记录在专业工作区中共享。"; },
      dispose: function () { disposed = true; listeners = []; }
    };
  }

  function mount(options) {
    options = options || {};
    var win = options.window || root, doc = options.document || win.document, ui = options.ui || win.PXD_UI, pane = doc.getElementById("pane-pro"), nodes = {}, timers = [], unsubscribe = null, controller, transport, disposed = false, renderedLists = {}, assets = new Map(), proComposer = null;
    requireValue(pane && ui, "UI_UNAVAILABLE", "专业工作区容器尚未加载");
    function node(tag, className, text, parent, id) { var el = doc.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; if (id) { el.id = id; nodes[id] = el; } if (parent) parent.appendChild(el); return el; }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function showError(e) { if (controller) controller.reportError(e); }
    function handle(fn) { return function () { try { Promise.resolve(fn.apply(null, arguments)).catch(showError); } catch (e) { showError(e); } }; }
    function button(parent, id, text, fn, className) { var el = ui.createButton(className || "studio-button ghost", text, handle(fn)); el.id = id; nodes[id] = el; parent.appendChild(el); return el; }
    function section(parent, title) { var el = node("div", "sec studio-section", null, parent); node("h3", "", title, el); return el; }
    function field(parent, id, label, tag) { var labelEl = node("label", "studio-field", null, parent); node("span", "studio-field-label", label, labelEl); var el = node(tag || "input", "studio-input", null, labelEl, id); if (!tag || tag === "input") el.type = "text"; el.setAttribute("aria-label", label); return el; }
    function setValue(el, value) { value = value == null ? "" : String(value); if (el.value !== value) el.value = value; }
    function disable(id, value) { if (nodes[id]) ui.setDisabled(nodes[id], value); }
    var workspace = node("div", "studio-workspace", null, pane, "studioWorkspace");
    ["proRow", "proComposer"].forEach(function (id) { var el = doc.getElementById(id); if (el) { el.hidden = true; el.style.display = "none"; } });
    var body = node("div", "studio-body", null, workspace, "studioBody"), draftSection = section(body, "共享草稿");
    var toolbar = node("div", "studio-row", null, draftSection);
    button(toolbar, "studioNewImage", "＋ 图像草稿", function () { return controller.createDraft("image.edit"); });
    button(toolbar, "studioNewLayer", "＋ 图层草稿", function () { return controller.createDraft("ps.layer.update"); });
    button(toolbar, "studioRefresh", "刷新", function () { return controller.refresh(); });
    button(toolbar, "studioLoadLatest", "舍弃本地并重新载入", function () { return controller.reloadDraft(); });
    node("div", "studio-note studio-service", "读取服务状态…", draftSection, "studioService");
    node("div", "studio-list studio-drafts", null, draftSection, "studioDraftList");
    node("div", "studio-note studio-revision", "新建草稿，或选择 Agent 已建立的草稿。", draftSection, "studioRevision");
    var conflict = node("div", "studio-conflict", null, draftSection, "studioConflict");
    node("div", "studio-note", "草稿已被 Agent / 其他界面更新。本地修改仍保留。", conflict);
    var conflicts = node("div", "studio-row", null, conflict);
    button(conflicts, "studioReload", "重新载入并舍弃本地修改", function () { return controller.reloadDraft(); });
    button(conflicts, "studioFork", "将本地内容另存为新草稿", function () { return controller.saveAsNew(); });
    var pending = node("div", "studio-conflict", null, draftSection, "studioPending");
    node("div", "studio-note", "上次提交尚未确认。先刷新任务；重试会沿用原请求编号。", pending);
    button(pending, "studioRetryRun", "核对原提交", function () { return controller.retryRun(); });
    var contextSection = section(body, "处理范围");
    var scopes = node("div", "studio-row", null, contextSection);
    button(scopes, "studioCaptureSelection", "捕获当前选区", function () { return controller.capture("selection"); });
    button(scopes, "studioCaptureDocument", "明确处理整图", function () { return controller.capture("document"); });
    var sourceRow = node("div", "studio-source", null, contextSection);
    var sourceImage = node("img", "studio-source-image", null, sourceRow, "studioSourceImage"); sourceImage.alt = "本次捕获的源图";
    node("div", "studio-note", "尚未捕获。不会自动扩大为整图。", sourceRow, "studioContext");
    var imageSection = section(body, "图像编辑"); nodes.imageSection = imageSection;
    var prompt = field(imageSection, "studioPrompt", "编辑指令", "textarea"); prompt.rows = 4; prompt.placeholder = "描述要改变的内容，以及希望保留的特征。";
    prompt.addEventListener("input", handle(function () { if (!proComposer) controller.editParams({ prompt: prompt.value }); }));
    var promptActions = node("div", "studio-row", null, imageSection);
    button(promptActions, "studioNewline", "↵ 换行", function () { if (proComposer) proComposer.newline(); else { prompt.value += "\n"; controller.editParams({ prompt: prompt.value }); prompt.focus(); } });
    node("span", "studio-note", "Enter 运行 · Shift 换行（跟随设置）", promptActions);
    var preserve = field(imageSection, "studioPreserve", "必须保留（每行一项）", "textarea"); preserve.rows = 2; preserve.placeholder = "本人特征\n服装细节";
    preserve.addEventListener("input", handle(function () { controller.editContext({ preserve: preserve.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 32) }); }));
    var imageOptions = node("div", "studio-row studio-options", null, imageSection);
    var ratio = field(imageOptions, "studioRatio", "画面比例", "select"), size = field(imageOptions, "studioImageSize", "输出尺寸", "select");
    ratio.addEventListener("change", handle(function () { if (ratio.value) controller.editParams({ aspectRatio: ratio.value }); }));
    size.addEventListener("change", handle(function () { if (size.value) controller.editParams({ imageSize: size.value }); }));
    var refsHead = node("div", "studio-row", null, imageSection);
    button(refsHead, "studioAddRef", "＋ 参考图", function () { return pickReferences(); });
    node("span", "studio-note", "保存到共享资产；用途可切换", refsHead);
    node("div", "studio-refs", null, imageSection, "studioRefs");
    var fileInput = node("input", "", null, workspace, "studioFile"); fileInput.type = "file"; fileInput.accept = "image/png,image/jpeg,image/webp"; fileInput.multiple = true; fileInput.hidden = true;
    fileInput.addEventListener("change", handle(async function () { await addFiles(Array.from(fileInput.files || []), false); fileInput.value = ""; }));
    var recipeSection = section(body, "配方"); nodes.recipeSection = recipeSection;
    var recipeSearch = field(recipeSection, "studioRecipeSearch", "查找配方"); recipeSearch.placeholder = "磨皮、清杂、场照、原设…";
    var recipeActions = node("div", "studio-row", null, recipeSection);
    button(recipeActions, "studioFindRecipes", "查找", function () { return controller.searchRecipes(recipeSearch.value); });
    button(recipeActions, "studioMoreRecipes", "更多", function () { return controller.searchRecipes(controller.snapshot().recipes.query, true); });
    node("div", "studio-list", null, recipeSection, "studioRecipeList");
    node("div", "studio-note", "查找并载入到图像草稿；不会自动执行。", recipeSection, "studioRecipeNote");
    node("div", "studio-recipe-params", null, recipeSection, "studioRecipeParams");
    var recipeText = field(recipeSection, "studioRecipeUserText", "本次配方的补充要求", "textarea"); recipeText.rows = 2;
    recipeText.addEventListener("input", function () { controller.setRecipeUserText(recipeText.value); });
    button(recipeSection, "studioLoadRecipe", "载入配方到共享草稿", function () { return controller.loadSelectedRecipe(); });
    var layerSection = section(body, "图层属性"); nodes.layerSection = layerSection;
    button(layerSection, "studioRefreshLayers", "刷新真实图层", function () { return controller.refreshLayers(); });
    node("div", "studio-note", "先捕获当前文档，再从 Photoshop 返回的图层中选择。", layerSection, "studioLayerHint");
    node("div", "studio-list studio-layers", null, layerSection, "studioLayerList");
    button(layerSection, "studioMoreLayers", "更多图层", function () { return controller.loadMoreLayers(); });
    var changeName = field(layerSection, "studioLayerName", "图层名称"), changeOpacity = field(layerSection, "studioLayerOpacity", "不透明度（0–100）"); changeOpacity.type = "number"; changeOpacity.min = "0"; changeOpacity.max = "100"; changeOpacity.step = "1";
    changeName.addEventListener("input", handle(function () { editChange("name", changeName.value); }));
    changeOpacity.addEventListener("input", handle(function () { if (changeOpacity.value !== "") editChange("opacity", Number(changeOpacity.value)); }));
    var layerOptions = node("div", "studio-row", null, layerSection);
    button(layerOptions, "studioLayerVisible", "可见性：保持", function () { var changes = controller.snapshot().form.params.changes || {}, next = Object.assign({}, changes); if (!Object.prototype.hasOwnProperty.call(next, "visible")) next.visible = true; else if (next.visible) next.visible = false; else delete next.visible; controller.editParams({ changes: next }); });
    button(layerOptions, "studioResetChanges", "清除属性修改", function () { controller.editParams({ changes: {} }); });
    var settingsSection = section(body, "执行与回贴");
    node("div", "studio-note", "图像回贴为新图层，支持 PNG/JPEG、最多 800 万像素；4K 生成需关闭自动回贴。图层属性任务直接修改所选层。", settingsSection);
    var settingsRow = node("div", "studio-row", null, settingsSection);
    button(settingsRow, "studioAutoApply", "自动回贴：关", function () { var context = controller.snapshot().form.context; controller.editContext({ settings: Object.assign({}, context.settings, { autoApply: !(context.settings && context.settings.autoApply) }) }); });
    button(settingsRow, "studioDisableGrouping", "自动编组尚不支持 · 点击关闭", function () { var context = controller.snapshot().form.context; controller.editContext({ settings: Object.assign({}, context.settings, { groupResults: false }) }); });
    var jobsSection = section(body, "任务与候选图");
    node("div", "studio-list studio-jobs", null, jobsSection, "studioJobList");
    node("div", "studio-note", "运行后会在这里保留任务快照与结果。", jobsSection, "studioJobDetail");
    var jobActions = node("div", "studio-row", null, jobsSection);
    button(jobActions, "studioCancel", "取消任务", function () { return controller.cancel(controller.snapshot().selectedJobId); });
    button(jobActions, "studioRollback", "撤销这次修改", function () { return controller.rollback(controller.snapshot().selectedJobId); });
    node("div", "studio-results", null, jobsSection, "studioResults");
    var footer = node("div", "composer studio-footer", null, workspace);
    node("div", "studio-message", "", footer, "studioNotice").setAttribute("role", "status");
    node("div", "studio-error", "", footer, "studioError").setAttribute("role", "alert");
    var actions = node("div", "studio-row", null, footer);
    button(actions, "studioSave", "保存草稿", function () { return controller.save(); });
    button(actions, "studioToAgent", "交给 Agent 接着做", function () { return toAgent(); });
    button(actions, "studioRun", "生成结果", function () { return controller.run(); }, "studio-button red studio-run");
    function editChange(key, value) { var changes = Object.assign({}, controller.snapshot().form.params.changes || {}); changes[key] = value; controller.editParams({ changes: changes }); }
    async function addFiles(files, native) {
      var draft = controller.snapshot().draft; requireValue(draft, "DRAFT_REQUIRED", "请先选择草稿");
      for (var i = 0; i < files.length; i++) {
        requireValue(controller.snapshot().draft && controller.snapshot().draft.draftId === draft.draftId, "DRAFT_CHANGED", "草稿已切换，未继续加入参考图");
        var file = files[i], bytes;
        requireValue(!file.size || file.size <= 32 * 1024 * 1024, "IMAGE_TOO_LARGE", "参考图超过 32 MiB");
        bytes = new Uint8Array(native ? await file.read({ format: require("uxp").storage.formats.binary }) : await file.arrayBuffer());
        requireValue(bytes.length && bytes.length <= 32 * 1024 * 1024, "IMAGE_TOO_LARGE", "参考图为空或超过 32 MiB");
        var extension = String(file.name || "").split(".").pop().toLowerCase(), mime = file.type || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" })[extension];
        requireValue(["image/png", "image/jpeg", "image/webp"].indexOf(mime) >= 0, "INVALID_IMAGE", "参考图只支持 PNG、JPEG、WebP");
        await controller.importReference({ base64: base64(bytes), mimeType: mime }, "reference");
      }
    }
    async function pickReferences() {
      if (win.PXD_CONTEXT && win.PXD_CONTEXT.isPhotoshop) {
        var selected = await require("uxp").storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"], allowMultiple: true });
        if (selected) await addFiles(Array.isArray(selected) ? selected : [selected], true);
      } else fileInput.click();
    }
    function toAgent() {
      var text = controller.agentReference(), input = doc.getElementById("prompt");
      if (win.PXD_NAV) win.PXD_NAV.showTab("agent");
      if (input) { input.value = text; input.focus(); }
      // Populate the existing composer only. The user decides when to send.
      return text;
    }
    function preview(img, assetId) {
      if (!assetId) { img.hidden = true; img.removeAttribute("src"); img._assetId = null; return; }
      if (img._assetId === assetId) return;
      img._assetId = assetId; img.hidden = false; img.removeAttribute("src");
      var currentTransport = transport;
      if (!assets.has(assetId)) {
        if (assets.size >= 12) assets.delete(assets.keys().next().value);
        assets.set(assetId, transport.readAsset(assetId).catch(function (e) { assets.delete(assetId); throw e; }));
      }
      assets.get(assetId).then(function (data) { if (!disposed && transport === currentTransport && img._assetId === assetId) img.src = data; }).catch(function () { if (img._assetId === assetId) { img.alt = "资产预览暂不可用"; img.hidden = true; } });
    }
    function list(name, signature, build) { var text = JSON.stringify(signature); if (renderedLists[name] === text) return; renderedLists[name] = text; clear(nodes[name]); build(nodes[name]); }
    function choices(select, values, selected) {
      var available = values || [], signature = JSON.stringify([available, selected]); if (select._signature === signature) return; select._signature = signature; clear(select);
      var empty = node("option", "", "模型默认", select); empty.value = ""; empty.disabled = !!selected;
      available.forEach(function (value) { var option = node("option", "", value === "auto" ? "跟随源图" : value, select); option.value = value; });
      if (selected && available.indexOf(selected) < 0) { var old = node("option", "", selected + "（待服务校验）", select); old.value = selected; }
      setValue(select, selected || "");
    }
    var labels = { queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", "recovery-required": "需要核对", "not-requested": "尚未回贴", applying: "回贴中", applied: "已回贴", "rolled-back": "已撤销", "rollback-conflict": "回贴/撤销待核对" };
    function render(state) {
      var draft = state.draft, context = state.form.context, imageMode = !draft || draft.capabilityId === "image.edit", host = state.discovery && state.discovery.photoshop && state.discovery.photoshop.connected, provider = state.discovery && state.discovery.provider, busy = state.busy;
      nodes.studioService.textContent = (host ? "PS 已连接" : "PS 未连接") + " · " + (provider && provider.configured ? "图像服务已配置 · " + provider.model : "图像服务未配置");
      nodes.studioRevision.textContent = draft ? draft.draftId + " · revision " + draft.revision + (state.dirty ? " · 本地修改未保存" : " · 已共享") : "新建草稿，或选择 Agent 已建立的草稿。";
      nodes.studioConflict.hidden = !state.conflict; nodes.studioPending.hidden = !state.pendingRun;
      nodes.studioNotice.textContent = state.notice; nodes.studioNotice.hidden = !state.notice;
      nodes.studioError.textContent = state.error ? state.error.message + " · " + state.error.code : ""; nodes.studioError.hidden = !state.error;
      list("studioDraftList", [state.drafts, draft && draft.draftId, busy], function (container) {
        state.drafts.forEach(function (d) { var title = d.capabilityId === "image.edit" ? (d.params.prompt || "图像草稿") : "图层属性 · " + (d.params.layerId || "待选择"); var choice = button(container, "draft_" + d.draftId, String(title).slice(0, 45) + " · r" + d.revision, function () { return controller.loadDraft(d.draftId); }, "studio-list-item" + (draft && d.draftId === draft.draftId ? " is-on" : "")); ui.setDisabled(choice, busy); });
      });
      nodes.imageSection.hidden = !imageMode; nodes.layerSection.hidden = imageMode;
      nodes.recipeSection.hidden = !imageMode;
      setValue(prompt, state.form.params.prompt); setValue(preserve, context && (context.preserve || []).join("\n"));
      if (proComposer) proComposer.sync();
      prompt.disabled = !draft || busy; preserve.disabled = !context || busy; ratio.disabled = !draft || busy; size.disabled = !draft || busy;
      var providerSettings = provider && provider.settings || {}; choices(ratio, providerSettings.aspectRatio || ["auto"], state.form.params.aspectRatio); choices(size, providerSettings.imageSize || [], state.form.params.imageSize);
      var recipes = state.recipes;
      nodes.studioMoreRecipes.hidden = recipes.nextOffset == null;
      nodes.studioRecipeNote.textContent = recipes.error || (recipes.loading ? "读取配方…" : recipes.selected ? recipes.selected.title + " · 参数调整后点击载入，替换编辑指令并保留处理范围与参考图。" : "查找并载入到图像草稿；不会自动执行。");
      list("studioRecipeList", [recipes.items, recipes.selected && recipes.selected.recipeId, busy], function (container) { recipes.items.forEach(function (recipe) { var choice = button(container, "recipe_" + recipe.recipeId, recipe.title + " · " + recipe.category, function () { return controller.selectRecipe(recipe.recipeId); }, "studio-list-item" + (recipes.selected && recipes.selected.recipeId === recipe.recipeId ? " is-on" : "")); ui.setDisabled(choice, busy); }); });
      list("studioRecipeParams", [recipes.selected && recipes.selected.recipeId, recipes.selected && recipes.selected.sourceHash], function (container) {
        (recipes.selected && recipes.selected.parameters || []).forEach(function (parameter) {
          var input = field(container, "recipe_parameter_" + parameter.id, parameter.label); input.type = "number"; input.min = String(parameter.min); input.max = String(parameter.max); input.step = String(parameter.step);
          if (parameter.description) input.title = parameter.description;
          input.addEventListener("input", handle(function () { if (input.value !== "") controller.setRecipeValue(parameter.id, Number(input.value)); }));
        });
      });
      (recipes.selected && recipes.selected.parameters || []).forEach(function (parameter) { var input = nodes["recipe_parameter_" + parameter.id]; setValue(input, recipes.values[parameter.id]); input.disabled = busy || recipes.loading; });
      setValue(recipeText, recipes.userText); recipeText.disabled = busy;
      disable("studioLoadRecipe", busy || !draft || !imageMode || !recipes.selected || recipes.loading || !!recipes.selected.requiresReferenceMapping || !!state.conflict);
      disable("studioFindRecipes", busy || recipes.loading); disable("studioMoreRecipes", busy || recipes.loading);
      var ref = context && context.documentRef, transform = context && context.transform;
      nodes.studioContext.textContent = context ? String(ref.name || "文档 " + ref.documentId) + " · " + (context.scope === "selection" ? "选区 " : "整图 ") + (transform ? transform.inputWidth + "×" + transform.inputHeight : ref.width + "×" + ref.height) + " · 已捕获" : "尚未捕获。不会自动扩大为整图。";
      preview(sourceImage, context && context.baseAssetId);
      var roleLabels = { reference: "参考", identity: "本人特征", style: "风格", structure: "结构" }, roles = ["reference", "identity", "style", "structure"];
      list("studioRefs", [context && context.refs, busy], function (container) {
        (context && context.refs || []).forEach(function (reference, index) {
          var item = node("div", "studio-ref", null, container), img = node("img", "studio-ref-image", null, item); img.alt = "参考图 " + (index + 1); preview(img, reference.assetId);
          var purpose = button(item, "ref_role_" + index, roleLabels[reference.role] || reference.role, function () { var refs = clone(controller.snapshot().form.context.refs); refs[index].role = roles[(roles.indexOf(refs[index].role) + 1) % roles.length]; controller.editContext({ refs: refs }); });
          var remove = button(item, "ref_remove_" + index, "移除", function () { var refs = clone(controller.snapshot().form.context.refs); refs.splice(index, 1); controller.editContext({ refs: refs }); }); ui.setDisabled(purpose, busy); ui.setDisabled(remove, busy);
        });
      });
      var observed = state.observed, layerContext = context && observed.document && context.documentRef.documentId === observed.document.id && context.documentRef.historyStateId === observed.document.historyStateId;
      list("studioLayerList", [observed.layers, state.form.params.layerId, !!layerContext, busy], function (container) {
        observed.layers.forEach(function (layer) { var choice = button(container, "layer_" + layer.id, String(layer.name) + " · #" + layer.id, function () { controller.selectLayer(layer.id); }, "studio-list-item" + (state.form.params.layerId === layer.id ? " is-on" : "")); ui.setDisabled(choice, busy || !layerContext); });
      });
      nodes.studioMoreLayers.hidden = observed.nextOffset == null;
      nodes.studioLayerHint.textContent = layerContext ? "来自当前 Photoshop 文档；只会修改已选层的指定属性。" : "先捕获当前文档，再刷新真实图层列表。";
      var selected = observed.layers.find(function (layer) { return layer.id === state.form.params.layerId; }), changes = state.form.params.changes || {};
      setValue(changeName, changes.name != null ? changes.name : selected && selected.name); setValue(changeOpacity, changes.opacity != null ? changes.opacity : selected && selected.opacity);
      changeName.disabled = busy || !selected || !layerContext; changeOpacity.disabled = busy || !selected || !layerContext;
      nodes.studioLayerVisible.textContent = "可见性：" + (changes.visible == null ? "保持" : changes.visible ? "显示" : "隐藏");
      nodes.studioAutoApply.hidden = !imageMode; nodes.studioAutoApply.textContent = "自动回贴：" + (context && context.settings && context.settings.autoApply ? "开" : "关"); nodes.studioAutoApply.setAttribute("aria-pressed", String(!!(context && context.settings && context.settings.autoApply)));
      nodes.studioDisableGrouping.hidden = !(context && context.settings && context.settings.groupResults);
      list("studioJobList", [state.jobs.map(function (j) { return [j.jobId, j.status, j.placement && j.placement.status, j.snapshot && j.snapshot.capabilityId]; }), state.selectedJobId], function (container) {
        state.jobs.forEach(function (job) { button(container, "job_" + job.jobId, (job.snapshot && job.snapshot.capabilityId === "ps.layer.update" ? "图层修改" : "图像编辑") + " · " + (labels[job.status] || job.status) + " · " + job.jobId.slice(0, 8), function () { controller.selectJob(job.jobId); }, "studio-list-item" + (job.jobId === state.selectedJobId ? " is-on" : "")); });
      });
      var job = state.jobs.find(function (j) { return j.jobId === state.selectedJobId; }), placement = job && job.placement || {};
      nodes.studioJobDetail.textContent = job ? (labels[job.status] || job.status) + " · " + (labels[placement.status] || placement.status || "尚未回贴") + " · 草稿 r" + job.snapshot.revision + (job.error ? "\n" + job.error.message : "") + (placement.error ? "\n" + placement.error.message : "") : "运行后会在这里保留任务快照与结果。";
      nodes.studioCancel.hidden = !job || ["queued", "running", "recovery-required"].indexOf(job.status) < 0; nodes.studioRollback.hidden = placement.status !== "applied";
      list("studioResults", [job, busy, host], function (container) {
        (job && job.results || []).forEach(function (result, index) {
          var candidate = node("div", "studio-candidate", null, container), img = node("img", "studio-result-image", null, candidate); img.alt = "候选图 " + (index + 1); preview(img, result.assetId);
          node("div", "studio-note", "候选 " + (index + 1), candidate);
          var paste = button(candidate, "apply_" + result.resultId, placement.status === "applied" && placement.receipt && placement.receipt.resultId === result.resultId ? "已回贴" : "回贴此图", function () { return controller.apply(job.jobId, result.resultId); });
          ui.setDisabled(paste, busy || !host || job.status !== "succeeded" || ["not-requested", "failed"].indexOf(placement.status || "not-requested") < 0);
        });
      });
      ["studioNewImage", "studioNewLayer", "studioReload", "studioFork", "studioRetryRun"].forEach(function (id) { disable(id, busy); });
      disable("studioLoadLatest", busy || !draft);
      ["studioCaptureSelection", "studioCaptureDocument", "studioRefreshLayers", "studioMoreLayers"].forEach(function (id) { disable(id, busy || !draft || !host); });
      ["studioAddRef", "studioAutoApply", "studioDisableGrouping"].forEach(function (id) { disable(id, busy || !context); });
      ["studioLayerVisible", "studioResetChanges"].forEach(function (id) { disable(id, busy || !selected || !layerContext); });
      disable("studioSave", busy || !draft || !state.dirty || !!state.conflict); disable("studioToAgent", busy || !draft || state.dirty || !!state.conflict); disable("studioRollback", busy || !host);
      nodes.studioRun.textContent = busy ? "处理中…" : imageMode ? "生成结果" : "修改图层";
      disable("studioRun", busy || !draft || !context || !!state.conflict || !!state.pendingRun || !host || imageMode && !(provider && provider.configured) || !imageMode && (!selected || !Object.keys(changes).length));
    }
    function connect() {
      if (controller) controller.dispose(); if (unsubscribe) unsubscribe(); renderedLists = {}; assets.clear();
      var configured = win.PXD_NAV ? win.PXD_NAV.baseUrl() : doc.getElementById("baseUrl") && doc.getElementById("baseUrl").value;
      transport = options.transport || createTransport({ base: configured, location: win.location });
      controller = createController({ transport: transport, storage: options.storage || win.localStorage });
      unsubscribe = controller.subscribe(render); mounted.controller = controller; mounted.transport = transport;
      controller.refresh().catch(function () {});
    }
    var mounted = { controller: null, transport: null, nodes: nodes, toAgent: toAgent, dispose: function () { disposed = true; if (controller) controller.dispose(); if (unsubscribe) unsubscribe(); if (proComposer) proComposer.close(); timers.forEach(clearInterval); var baseInput = doc.getElementById("baseUrl"); if (baseInput) baseInput.removeEventListener("change", connect); if (workspace.parentElement) workspace.parentElement.removeChild(workspace); } };
    connect();
    if (win.PXD_COMPOSER) proComposer = win.PXD_COMPOSER.attach({ field: prompt, frame: prompt.parentElement, document: doc, native: !!(win.PXD_CONTEXT && win.PXD_CONTEXT.isPhotoshop), enterSends: function () { try { return win.localStorage.getItem("pxdls.enter-send") !== "false"; } catch (_) { return true; } }, send: handle(function () { if (!ui.isDisabled(nodes.studioRun)) return controller.run(); }), saveDraft: function () { if (controller.snapshot().draft && controller.snapshot().form.params.prompt !== prompt.value) controller.editParams({ prompt: prompt.value }); } });
    var baseInput = doc.getElementById("baseUrl"); if (baseInput) baseInput.addEventListener("change", connect);
    if (options.poll !== false) timers.push(setInterval(function () { if (!disposed && doc.visibilityState !== "hidden") controller.refresh().catch(function () {}); }, 2500));
    return mounted;
  }
  var api = { createTransport: createTransport, createController: createController, baseFor: baseFor, mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.PXD_STUDIO_API = api;
    if (root.document && root.document.getElementById("pane-pro")) {
      root.PXD_STUDIO = mount();
      root.addEventListener("unload", function () { root.PXD_STUDIO.dispose(); });
    }
  }
})(typeof window !== "undefined" ? window : null);
