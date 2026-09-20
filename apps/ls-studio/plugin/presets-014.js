/* User presets share the Companion library with MCP. No local preset database. */
(function (root) {
  "use strict";
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function empty() { return { title: "", category: "head", subCategory: "", content: '{\n  "instruction": "",\n  "@param:强度": 0.5\n}', refImages: [] }; }
  function definition(recipe) { return { title: recipe.title, category: recipe.category, subCategory: recipe.subCategory || "", content: recipe.content, refImages: (recipe.refImages || []).map(function (slot, index) { return { slotId: slot && slot.slotId || "reference-" + (index + 1), label: slot && slot.label || "参考 " + (index + 1), role: slot && slot.role || "reference" }; }) }; }
  function parseImport(text) {
    if (typeof text !== "string" || unescape(encodeURIComponent(text)).length > 512 * 1024) fail("INVALID_RECIPE", "预设文件不能超过 512 KiB");
    try { return JSON.parse(text); } catch (_) { fail("INVALID_RECIPE", "预设文件不是有效 JSON"); }
  }
  function createController(options) {
    var listeners = [], disposed = false, pending = null, sequence = 0, windowSize = 20;
    var makeId = options.makeId || function () { return "preset_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); };
    var state = { items: [], total: 0, nextOffset: null, query: "", kind: "all", includeArchived: false, selected: null, form: empty(), versions: [], dirty: false, busy: false, error: null, notice: "" };
    function active() { if (disposed) fail("DISPOSED", "预设库连接已切换"); }
    function call(operation, args) { active(); return options.transport.call(operation, args); }
    function emit() { if (!disposed) listeners.forEach(function (listener) { listener(clone(state)); }); }
    function clean() { if (state.dirty) fail("UNSAVED_PRESET", "预设有未保存修改，请保存、另存或明确放弃后再切换"); }
    function problem(e) { state.error = { code: e.code || "PRESET_ERROR", message: e.message || "预设操作失败" }; emit(); return e; }
    async function refresh(append, reset) {
      active();
      if (reset) windowSize = 20;
      else if (append) { if (state.nextOffset === null) return; windowSize = Math.max(windowSize, state.items.length + 20); }
      var token = ++sequence, target = windowSize, offset = 0, items = [], page, filters = { q: state.query, kind: state.kind, includeArchived: state.includeArchived };
      do {
        page = await call("listRecipes", Object.assign({}, filters, { offset: offset, limit: Math.min(200, target - items.length) }));
        if (disposed || token !== sequence) return;
        items = items.concat(page.items); offset = page.nextOffset;
      } while (offset !== null && items.length < target);
      state.items = items; state.total = page.total; state.nextOffset = page.nextOffset; emit();
    }
    async function accept(recipe) {
      active(); state.selected = clone(recipe); state.form = definition(recipe); state.dirty = false; pending = null;
      state.versions = await call("listRecipeVersions", { recipeId: recipe.recipeId }); active(); emit();
    }
    async function write(fn) {
      active(); if (state.busy) fail("UI_BUSY", "上一项预设操作仍在进行");
      state.busy = true; state.error = null; emit();
      try { return await fn(); } catch (e) { throw problem(e); } finally { state.busy = false; emit(); }
    }
    function newRequest(operation, payload) {
      var signature = JSON.stringify([operation, payload]);
      if (!pending || pending.signature !== signature) pending = { signature: signature, requestId: makeId() };
      return pending.requestId;
    }
    async function saved(recipe) { await accept(recipe); state.notice = "已保存到共享预设库 · revision " + recipe.revision; await refresh(); return recipe; }
    return {
      snapshot: function () { return clone(state); },
      subscribe: function (listener) { listeners.push(listener); listener(clone(state)); return function () { listeners = listeners.filter(function (item) { return item !== listener; }); }; },
      refresh: refresh,
      search: async function (query, kind, archived) { active(); var nextQuery = String(query || ""), nextKind = kind || "all", changed = state.query !== nextQuery || state.kind !== nextKind || state.includeArchived !== !!archived; state.query = nextQuery; state.kind = nextKind; state.includeArchived = !!archived; return refresh(false, changed); },
      select: function (recipeId, discard) { return write(async function () { if (!discard) clean(); await accept(await call("getRecipe", { recipeId: recipeId })); state.notice = ""; }); },
      newPreset: function () { active(); clean(); state.selected = null; state.form = empty(); state.versions = []; state.notice = "填写预设后保存；不会执行图像编辑"; state.error = null; emit(); },
      discard: function () { return write(async function () { if (state.selected) { await accept(await call("getRecipe", { recipeId: state.selected.recipeId })); state.notice = "已放弃本地修改并载入最新预设"; } else { state.form = empty(); state.versions = []; state.dirty = false; pending = null; state.notice = "已放弃未保存的新预设"; } }); },
      edit: function (patch) { active(); if (state.busy) fail("UI_BUSY", "操作期间请稍后编辑"); state.form = Object.assign({}, state.form, clone(patch)); state.dirty = true; emit(); },
      save: function (asNew) { return write(async function () {
        var payload = { definition: clone(state.form) }, selected = state.selected;
        if (selected && !asNew) {
          if (selected.kind !== "user" || selected.archived) fail("RECIPE_READ_ONLY", "工厂预设或归档预设不能直接编辑，请复制或恢复");
          return saved(await call("updateRecipe", Object.assign(payload, { recipeId: selected.recipeId, expectedRevision: selected.revision })));
        }
        return saved(await call("createRecipe", Object.assign(payload, { requestId: newRequest("createRecipe", payload) })));
      }); },
      copy: function () { return write(async function () {
        clean(); if (!state.selected) fail("RECIPE_REQUIRED", "先选择一份预设");
        var args = { recipeId: state.selected.recipeId, revision: state.selected.revision, expectedSourceHash: state.selected.sourceHash };
        args.requestId = newRequest("copyRecipe", args); return saved(await call("copyRecipe", args));
      }); },
      importText: function (text) { return write(async function () { clean(); var args = { bundle: parseImport(text) }; args.requestId = newRequest("importRecipe", args); return saved(await call("importRecipe", args)); }); },
      exportText: function () { return write(async function () { clean(); if (!state.selected) fail("RECIPE_REQUIRED", "先选择一份预设"); return JSON.stringify(await call("exportRecipe", { recipeId: state.selected.recipeId, revision: state.selected.revision }), null, 2); }); },
      archive: function () { return write(async function () { clean(); if (!state.selected || state.selected.kind !== "user") fail("RECIPE_READ_ONLY", "只可归档用户预设"); return saved(await call("archiveRecipe", { recipeId: state.selected.recipeId, expectedRevision: state.selected.revision })); }); },
      restore: function (revision) { return write(async function () { clean(); if (!state.selected || state.selected.kind !== "user") fail("RECIPE_READ_ONLY", "只可恢复用户预设"); return saved(await call("restoreRecipe", Object.assign({ recipeId: state.selected.recipeId, expectedRevision: state.selected.revision }, revision === undefined ? {} : { targetRevision: revision }))); }); },
      use: function () { return write(async function () { clean(); if (!state.selected || state.selected.archived) fail("RECIPE_ARCHIVED", "请选择未归档预设"); active(); await options.onUse(state.selected.recipeId); state.notice = "已选入配方区；调整参数并映射参考图后点击载入"; }); },
      reportError: problem, dispose: function () { disposed = true; sequence++; listeners = []; }
    };
  }
  function createFileIO(options) {
    var win = options.window, doc = options.document;
    return {
      read: async function () {
        if (options.native) {
          var storage = (options.requireImpl || require)("uxp").storage, file = await storage.localFileSystem.getFileForOpening({ types: ["json"], allowMultiple: false });
          if (!file) return null;
          var meta = await file.getMetadata(); if (meta.size > 512 * 1024) fail("INVALID_RECIPE", "预设文件不能超过 512 KiB");
          return file.read({ format: storage.formats.utf8 });
        }
        return new Promise(function (resolve, reject) {
          var input = doc.createElement("input"); input.type = "file"; input.accept = ".json,application/json";
          input.addEventListener("cancel", function () { resolve(null); });
          input.addEventListener("change", async function () { try { var file = input.files && input.files[0]; if (!file) return resolve(null); if (file.size > 512 * 1024) fail("INVALID_RECIPE", "预设文件不能超过 512 KiB"); resolve(await file.text()); } catch (e) { reject(e); } });
          input.click();
        });
      },
      save: async function (text) {
        if (options.native) {
          var storage = (options.requireImpl || require)("uxp").storage, file = await storage.localFileSystem.getFileForSaving("ls-studio-preset.json", { types: ["json"] });
          if (!file) return false; await file.write(text, { format: storage.formats.utf8 }); return true;
        }
        var url = win.URL.createObjectURL(new win.Blob([text], { type: "application/json" })), link = doc.createElement("a");
        link.href = url; link.download = "ls-studio-preset.json"; doc.body.appendChild(link); link.click(); doc.body.removeChild(link);
        setTimeout(function () { win.URL.revokeObjectURL(url); }, 1000); return true;
      }
    };
  }
  function mount(options) {
    var doc = options.document, ui = options.ui, container = options.container, nodes = {}, controller = createController(options), unsubscribe, listKey = "", slotsKey = "", versionKey = "";
    var fileIO = options.fileIO || createFileIO(options);
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function el(tag, id, parent, text) { var node = doc.createElement(tag); if (id) { node.id = id; nodes[id] = node; } if (text !== undefined) node.textContent = text; if (parent) parent.appendChild(node); return node; }
    function handle(fn) { return function () { try { Promise.resolve(fn()).catch(controller.reportError); } catch (e) { controller.reportError(e); } }; }
    function button(id, label, fn, parent) { var node = ui.createButton("studio-button ghost", label, handle(fn)); node.id = id; nodes[id] = node; (parent || actions).appendChild(node); return node; }
    function field(id, label, tag, parent) { var wrap = el("label", null, parent || form); wrap.className = "studio-field"; el("span", null, wrap, label); var input = el(tag || "input", id, wrap); input.className = "studio-input"; input.setAttribute("aria-label", label); return input; }
    clear(container); container.className += " studio-presets";
    el("h3", null, container, "共享预设库");
    var filters = el("div", null, container), query = field("presetQuery", "搜索预设", "input", filters), kind = field("presetKind", "来源", "select", filters), archived = field("presetArchived", "包含归档", "input", filters); archived.type = "checkbox";
    [["all", "全部"], ["user", "我的预设"], ["factory", "工厂预设"]].forEach(function (item) { var option = el("option", null, kind, item[1]); option.value = item[0]; });
    var actions = el("div", null, container); actions.className = "studio-row";
    button("presetRefresh", "搜索 / 刷新", function () { return controller.search(query.value, kind.value, archived.checked); });
    button("presetNew", "新建", function () { return controller.newPreset(); });
    button("presetImport", "导入 JSON", async function () { var text = await fileIO.read(); if (text !== null) return controller.importText(text); });
    var list = el("div", "presetList", container); list.className = "studio-list";
    button("presetMore", "更多", function () { return controller.refresh(true); });
    var note = el("div", "presetNotice", container); note.className = "studio-note";
    var form = el("div", null, container); form.className = "preset-editor";
    var title = field("presetTitle", "预设名称"), category = field("presetCategory", "分类"), sub = field("presetSubCategory", "子分类"), content = field("presetContent", "编辑指令与参数 JSON", "textarea"); content.rows = 7;
    el("div", null, form, 'JSON 对象中的 @param:名称 为 0–1 默认值；同名 _desc 字段可说明参数。');
    [[title, "title"], [category, "category"], [sub, "subCategory"], [content, "content"]].forEach(function (pair) { pair[0].addEventListener("input", handle(function () { var patch = {}; patch[pair[1]] = pair[0].value; controller.edit(patch); })); });
    var slots = el("div", "presetSlots", form);
    button("presetAddSlot", "＋ 参考槽", function () { var refs = controller.snapshot().form.refImages; refs.push({ slotId: "slot-" + Date.now().toString(36) + "-" + refs.length, label: "参考 " + (refs.length + 1), role: "reference" }); controller.edit({ refImages: refs }); }, form);
    el("div", null, form, "预设保存参考槽与用途。图片不随 JSON 导出；在配方区显式选择参考图。");
    var editActions = el("div", null, form); editActions.className = "studio-row";
    button("presetSave", "保存预设", function () { return controller.save(false); }, editActions);
    button("presetSaveNew", "将当前内容另存", function () { return controller.save(true); }, editActions);
    button("presetCopy", "复制所选预设", function () { return controller.copy(); }, editActions);
    button("presetReload", "放弃未保存预设", function () { return controller.discard(); }, editActions);
    button("presetUse", "在配方区使用", function () { return controller.use(); }, editActions);
    button("presetExport", "导出 JSON", async function () { var text = await controller.exportText(); await fileIO.save(text); }, editActions);
    button("presetArchive", "归档", function () { return controller.archive(); }, editActions);
    var versions = field("presetVersions", "历史版本", "select");
    button("presetRestore", "恢复所选历史版本", function () { return controller.restore(Number(versions.value)); }, form);
    function set(input, value) { if (input.value !== value) input.value = value; }
    unsubscribe = controller.subscribe(function (state) {
      var current = state.selected, editable = !current || current.kind === "user" && !current.archived;
      note.textContent = state.error ? state.error.code + " · " + state.error.message : state.notice || (current ? current.title + " · " + (current.kind === "factory" ? "工厂，只读" : "用户 revision " + current.revision + (current.archived ? " · 已归档" : "")) : "新建或选择预设；保存不会修改当前草稿或 Photoshop");
      set(title, state.form.title); set(category, state.form.category); set(sub, state.form.subCategory); set(content, state.form.content);
      [title, category, sub, content].forEach(function (input) { input.disabled = state.busy || !editable; });
      var key = JSON.stringify([state.items, current && current.recipeId, state.busy]);
      if (key !== listKey) { listKey = key; clear(list); state.items.forEach(function (item) { var choice = button("preset_" + item.recipeId, item.title + " · " + (item.kind === "factory" ? "工厂" : "r" + item.revision) + (item.archived ? " · 归档" : ""), function () { return controller.select(item.recipeId); }, list); ui.setDisabled(choice, state.busy); }); }
      var refKey = JSON.stringify([state.form.refImages.map(function (slot) { return slot.slotId; }), editable, state.busy]);
      if (refKey !== slotsKey) { slotsKey = refKey; clear(slots); state.form.refImages.forEach(function (slot, index) {
        var row = el("div", null, slots), label = field("presetSlotLabel_" + index, "参考槽 " + (index + 1), "input", row), role = field("presetSlotRole_" + index, "用途", "select", row);
        ["reference", "identity", "style", "structure"].forEach(function (name) { var option = el("option", null, role, name); option.value = name; });
        function change() { var refs = controller.snapshot().form.refImages; refs[index] = { slotId: slot.slotId, label: label.value, role: role.value }; controller.edit({ refImages: refs }); }
        label.addEventListener("input", handle(change)); role.addEventListener("change", handle(change)); label.disabled = role.disabled = state.busy || !editable;
        var remove = button("presetSlotRemove_" + index, "移除", function () { var refs = controller.snapshot().form.refImages; refs.splice(index, 1); controller.edit({ refImages: refs }); }, row); ui.setDisabled(remove, state.busy || !editable);
      }); }
      state.form.refImages.forEach(function (slot, index) { set(nodes["presetSlotLabel_" + index], slot.label || "参考 " + (index + 1)); set(nodes["presetSlotRole_" + index], slot.role || "reference"); });
      var historyKey = JSON.stringify(state.versions); if (historyKey !== versionKey) { versionKey = historyKey; clear(versions); state.versions.forEach(function (version) { var option = el("option", null, versions, "r" + version.revision + " · " + version.title + " · " + version.action); option.value = String(version.revision); }); if (state.versions.length) versions.value = String(state.versions[0].revision); }
      ui.setDisabled(nodes.presetSave, state.busy || !editable); ui.setDisabled(nodes.presetSaveNew, state.busy); ui.setDisabled(nodes.presetAddSlot, state.busy || !editable || state.form.refImages.length >= 16);
      ["presetRefresh", "presetNew", "presetImport"].forEach(function (id) { ui.setDisabled(nodes[id], state.busy); });
      ["presetCopy", "presetExport"].forEach(function (id) { ui.setDisabled(nodes[id], state.busy || !current); });
      nodes.presetReload.textContent = current ? "放弃修改并重新载入" : "放弃未保存预设"; ui.setDisabled(nodes.presetReload, state.busy || !current && !state.dirty);
      ui.setDisabled(nodes.presetUse, state.busy || !current || current.archived); ui.setDisabled(nodes.presetArchive, state.busy || !current || current.kind !== "user" || current.archived);
      ui.setDisabled(nodes.presetRestore, state.busy || !current || current.kind !== "user"); versions.disabled = state.busy;
      nodes.presetMore.hidden = state.nextOffset === null; ui.setDisabled(nodes.presetMore, state.busy);
    });
    return { controller: controller, nodes: nodes, refresh: function () { return controller.refresh().catch(controller.reportError); }, dispose: function () { controller.dispose(); unsubscribe(); clear(container); } };
  }
  var api = { createController: createController, createFileIO: createFileIO, parseImport: parseImport, mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_PRESETS = api;
})(typeof window !== "undefined" ? window : null);
