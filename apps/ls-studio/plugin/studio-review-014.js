/* Shared candidate review. Review writes never generate or place pixels. */
(function (root) {
  "use strict";
  var categories = [["identity", "人物特征"], ["composition", "构图"], ["lighting", "光线"], ["color", "色彩"], ["detail", "细节"], ["artifact", "瑕疵"], ["scope", "处理范围"], ["style", "风格"], ["other", "其他"]];
  var sources = ["ui", "agent", "system"], serial = 0;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function text(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max; }
  function identifier(value) { return text(value, 128) && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value); }
  function timestamp(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
  function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
  function attribution(value) { return sources.indexOf(value.recordedVia) !== -1 && timestamp(value.updatedAt); }
  function feedbackValue(value) {
    return { items: value.items.map(function (item) { var result = { category: item.category, description: item.description }; if (item.area !== undefined && item.area !== "") result.area = item.area; if (item.requestedChange !== undefined && item.requestedChange !== "") result.requestedChange = item.requestedChange; return result; }), preserve: value.preserve.slice() };
  }
  function equal(a, b) { return JSON.stringify(feedbackValue(a)) === JSON.stringify(feedbackValue(b)); }
  function emptyFeedback() { return { items: [], preserve: [] }; }
  function validFeedback(value) {
    if (!object(value) || !Array.isArray(value.items) || value.items.length > 20 || !Array.isArray(value.preserve) || value.preserve.length > 20) return false;
    if (!value.items.every(function (item) { return object(item) && categories.some(function (category) { return category[0] === item.category; }) && text(item.description, 2000) && (item.area === undefined || text(item.area, 120)) && (item.requestedChange === undefined || text(item.requestedChange, 2000)); })) return false;
    if (!value.preserve.every(function (item) { return text(item, 500); })) return false;
    try { return encodeURIComponent(JSON.stringify(feedbackValue(value))).replace(/%[A-F\d]{2}/gi, "x").length <= 64 * 1024; } catch (_) { return false; }
  }
  function validReview(value) {
    if (!object(value) || !revision(value.revision) || !Array.isArray(value.feedback) || !(value.acceptance === null || object(value.acceptance))) return false;
    var seen = new Set();
    if (!value.feedback.every(function (item) { if (!object(item) || !identifier(item.resultId) || seen.has(item.resultId) || !validFeedback(item) || !attribution(item)) return false; seen.add(item.resultId); return true; })) return false;
    if (value.acceptance !== null && (!(value.acceptance.resultId === null || identifier(value.acceptance.resultId)) || !attribution(value.acceptance))) return false;
    return value.revision === 0 ? value.feedback.length === 0 && value.acceptance === null : timestamp(value.updatedAt);
  }
  function validPrevious(value) { return value === null || object(value) && identifier(value.jobId) && identifier(value.resultId) && revision(value.reviewRevision) && value.reviewRevision > 0 && attribution(value); }
  function savedFeedback(review, resultId) { var found = review && review.feedback.find(function (item) { return item.resultId === resultId; }); return found ? feedbackValue(found) : emptyFeedback(); }
  function validRead(value, jobId) { return object(value) && value.jobId === jobId && validReview(value.review) && validPrevious(value.previousAccepted); }
  function validAck(value, pending) {
    var args = pending.args;
    if (!object(value) || value.jobId !== args.jobId || !validReview(value.review) || typeof value.duplicate !== "boolean" || value.appliedRevision !== args.expectedReviewRevision + 1 || value.review.revision < value.appliedRevision || (!value.duplicate && value.review.revision !== value.appliedRevision)) return false;
    if (value.review.revision !== value.appliedRevision) return true;
    if (pending.operation === "setAcceptedResult") return value.review.acceptance !== null && value.review.acceptance.resultId === args.resultId && (value.duplicate || value.review.acceptance.recordedVia === "ui");
    var found = value.review.feedback.find(function (item) { return item.resultId === args.resultId; });
    return args.feedback === null ? !found : !!found && equal(found, args.feedback) && (value.duplicate || found.recordedVia === "ui");
  }
  function freeze(value) { if (value && typeof value === "object") { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); } return value; }
  function requestId() { return "review-ui-" + Date.now().toString(36) + "-" + (++serial).toString(36) + "-" + Math.random().toString(36).slice(2, 12); }
  function failure(code) { var error = new Error("审阅响应无效"); error.code = code; return error; }

  function mount(options) {
    var doc = options.document, ui = options.ui, nodes = {}, sessions = new Map(), scope = null, scopeKey = null, job = null, resultId = null, busy = false, epoch = 0, disposed = false, displayKey = "", displayVersion = -1;
    function node(tag, className, label, parent, id) { var el = doc.createElement(tag); el.className = className || ""; if (label !== null) el.textContent = label || ""; if (id) { el.id = id; nodes[id] = el; } if (parent) parent.appendChild(el); return el; }
    function button(parent, id, label, action) { var el = ui.createButton("studio-button ghost", label, function () { try { Promise.resolve(action()).catch(function () { localFailure("审阅操作暂不可用，请重新读取后再试。"); }); } catch (_) { localFailure("审阅操作暂不可用，请重新读取后再试。"); } }); el.id = id; nodes[id] = el; parent.appendChild(el); return el; }
    var panel = node("div", "studio-section studio-review", null, options.parent, "studioReviewPanel");
    node("div", "studio-review-title", "候选审阅", panel);
    var status = node("div", "studio-note", "", panel, "studioReviewStatus"); status.setAttribute("role", "status");
    var decision = node("div", "studio-row", null, panel);
    var accept = button(decision, "studioReviewAccept", "采用此候选", function () { return begin("setAcceptedResult", resultId); });
    var clearAcceptance = button(decision, "studioReviewClearAcceptance", "取消采用", function () { return begin("setAcceptedResult", null); });
    var previous = button(decision, "studioReviewPrevious", "查看此前采用版本", navigatePrevious);
    node("div", "studio-note", "采用只记录选择；反馈与采用分别保存。", panel);
    var editor = node("div", "studio-review-editor", null, panel, "studioReviewEditor");
    node("div", "studio-note", "局部反馈", editor);
    var items = node("div", "studio-review-items", null, editor, "studioReviewItems");
    var addRow = node("div", "studio-row", null, editor);
    var addItem = button(addRow, "studioReviewAddItem", "添加问题", function () { editCollection("items", { category: "other", description: "" }); });
    node("div", "studio-note", "需要保留的内容", editor);
    var preserve = node("div", "studio-review-items", null, editor, "studioReviewPreserve");
    var preserveRow = node("div", "studio-row", null, editor);
    var addPreserve = button(preserveRow, "studioReviewAddPreserve", "添加保留项", function () { editCollection("preserve", ""); });
    var saveRow = node("div", "studio-row", null, editor);
    var save = button(saveRow, "studioReviewSave", "保存反馈", function () { return begin("updateResultFeedback", resultId, false); });
    var remove = button(saveRow, "studioReviewDelete", "删除已保存反馈", function () { return begin("updateResultFeedback", resultId, true); });
    var reload = button(saveRow, "studioReviewReload", "重新读取审阅", discardAndReload);
    var retry = button(saveRow, "studioReviewRetry", "核对上次保存", reconcile);
    var message = node("div", "studio-message", "", panel, "studioReviewMessage"); message.setAttribute("role", "status");
    var error = node("div", "studio-error studio-review-error", "", panel, "studioReviewError"); error.setAttribute("role", "alert");
    var conflict = node("div", "studio-conflict", "", panel, "studioReviewConflict");
    node("div", "studio-note", "", conflict, "studioReviewConflictText");
    node("div", "studio-note studio-review-current", "", conflict, "studioReviewCurrentFeedback");

    function transportKey(transport) { return transport && typeof transport.base === "string" && transport.base ? transport.base : transport; }
    function invalidate() {
      epoch++; if (!scope) return;
      scope.forEach(function (record) { record.sequence++; record.read = null; record.loading = false; if (record.pending) { record.pending.attempting = false; record.pending.uncertain = true; record.notice = ""; record.error = "连接已重置，上次保存尚未确认。请核对上次保存后再修改共享审阅。"; } });
    }
    function bindScope() {
      var transport = options.getTransport(), key = transportKey(transport);
      if (key !== scopeKey || !scope) { invalidate(); scopeKey = key; if (!sessions.has(key)) sessions.set(key, new Map()); scope = sessions.get(key); displayKey = ""; }
      return transport;
    }
    function currentRecord() { return scope && job && scope.get(job.jobId); }
    function recordFor(selectedJob) {
      if (!scope.has(selectedJob.jobId)) scope.set(selectedJob.jobId, { jobId: selectedJob.jobId, scopeKey: scopeKey, review: null, previous: null, editors: new Map(), sequence: 0, read: null, loading: false, verifiedEpoch: -1, pending: null, conflict: null, error: "", notice: "" });
      return scope.get(selectedJob.jobId);
    }
    function editorFor(record, id) {
      if (!record.editors.has(id)) { var value = savedFeedback(record.review, id); record.editors.set(id, { value: clone(value), baseValue: clone(value), baseRevision: record.review ? record.review.revision : 0, dirty: false, version: 0, uiVersion: 0 }); }
      return record.editors.get(id);
    }
    function currentEditor() { var record = currentRecord(); return record && resultId ? editorFor(record, resultId) : null; }
    function localFailure(label) { var record = currentRecord(); if (record) { record.error = label; record.notice = ""; draw(); } }
    function changed(record, entry) { entry.version++; var saved = savedFeedback(record.review, resultId); entry.dirty = !equal(entry.value, saved); if (!entry.dirty && record.review) { entry.baseValue = clone(saved); entry.baseRevision = record.review.revision; } record.notice = ""; if (!record.pending && !record.conflict) record.error = ""; draw(); }
    function editCollection(key, value) { var record = currentRecord(), entry = currentEditor(); if (!record || !entry || !record.review || entry.value[key].length >= 20) return; entry.value[key].push(clone(value)); entry.uiVersion++; changed(record, entry); }
    function field(parent, id, label, tag, value, onChange, maxLength) {
      var wrap = node("label", "studio-field", null, parent); node("span", "studio-field-label", label, wrap);
      var input = node(tag, "studio-input", null, wrap, id); if (tag === "input") { input.type = "text"; input.setAttribute("type", "text"); }
      input.value = value || ""; input.setAttribute("aria-label", label); if (maxLength) input.setAttribute("maxlength", String(maxLength));
      input.addEventListener("focus", function () { wrap.classList.add("is-focused"); }); input.addEventListener("blur", function () { wrap.classList.remove("is-focused"); });
      input.addEventListener(tag === "select" ? "change" : "input", function () { onChange(input.value); });
      return input;
    }
    function clearFields(parent) { while (parent.firstChild) parent.removeChild(parent.firstChild); }
    function paintFields(record, entry) {
      clearFields(items); clearFields(preserve); nodes.studioReviewItemFields = []; nodes.studioReviewPreserveFields = [];
      if (!entry) return;
      function update(fn) { if (disposed || currentRecord() !== record || currentEditor() !== entry) return; fn(); changed(record, entry); }
      if (!entry.value.items.length) node("div", "studio-note studio-review-empty", "暂未添加问题。", items);
      entry.value.items.forEach(function (item, index) {
        var row = node("div", "studio-review-item", null, items), header = node("div", "studio-row", null, row);
        node("div", "studio-note", "问题 " + (index + 1), header);
        var removeItem = button(header, "studioReviewRemoveItem_" + index, "移除问题 " + (index + 1), function () { update(function () { entry.value.items.splice(index, 1); entry.uiVersion++; }); });
        var fields = { remove: removeItem };
        fields.area = field(row, "studioReviewArea_" + index, "区域（可选）", "input", item.area, function (value) { update(function () { if (value === "") delete item.area; else item.area = value; }); }, 120);
        fields.category = field(row, "studioReviewCategory_" + index, "问题类型", "select", item.category, function (value) { update(function () { item.category = value; }); });
        categories.forEach(function (category) { var option = node("option", "", category[1], fields.category); option.value = category[0]; }); fields.category.value = item.category;
        fields.description = field(row, "studioReviewDescription_" + index, "问题描述", "textarea", item.description, function (value) { update(function () { item.description = value; }); }, 2000);
        fields.requestedChange = field(row, "studioReviewRequestedChange_" + index, "修改建议（可选）", "textarea", item.requestedChange, function (value) { update(function () { if (value === "") delete item.requestedChange; else item.requestedChange = value; }); }, 2000);
        nodes.studioReviewItemFields.push(fields);
      });
      if (!entry.value.preserve.length) node("div", "studio-note studio-review-empty", "暂未添加保留项。", preserve);
      entry.value.preserve.forEach(function (value, index) {
        var row = node("div", "studio-review-item", null, preserve);
        var input = field(row, "studioReviewPreserve_" + index, "保留项 " + (index + 1), "textarea", value, function (next) { update(function () { entry.value.preserve[index] = next; }); }, 500);
        var actions = node("div", "studio-row", null, row), removePreserve = button(actions, "studioReviewRemovePreserve_" + index, "移除保留项 " + (index + 1), function () { update(function () { entry.value.preserve.splice(index, 1); entry.uiVersion++; }); });
        nodes.studioReviewPreserveFields.push({ input: input, remove: removePreserve });
      });
    }
    function loadEditor(entry, value, nextRevision) {
      if (!equal(entry.value, value)) { entry.value = clone(value); entry.uiVersion++; entry.version++; }
      entry.baseValue = clone(value); entry.baseRevision = nextRevision; entry.dirty = false;
    }
    function ingest(record, nextReview, confirmed) {
      // Job-list snapshots and reads begun before a write must never roll back a known review.
      if (record.review && nextReview.revision < record.review.revision) { if (!confirmed) return false; nextReview = record.review; }
      record.review = clone(nextReview);
      record.editors.forEach(function (entry, id) {
        var value = savedFeedback(nextReview, id), targetsEditor = confirmed && confirmed.pending.operation === "updateResultFeedback" && confirmed.pending.args.resultId === id;
        var pending = confirmed ? confirmed.pending : record.pending;
        var newerIntent = pending && pending.operation === "updateResultFeedback" && pending.args.resultId === id && entry.version !== pending.editorVersion;
        // A newer edit may intentionally return to the old base text. A false
        // dirty flag does not authorize an ACK/read-back to erase that intent.
        if (!entry.dirty && !newerIntent || targetsEditor && entry.version === confirmed.pending.editorVersion) { loadEditor(entry, value, nextReview.revision); return; }
        if (newerIntent && !confirmed) entry.dirty = !equal(entry.value, value);
        if (confirmed && nextReview.revision === confirmed.appliedRevision && entry.baseRevision === confirmed.pending.args.expectedReviewRevision) {
          entry.baseValue = clone(value); entry.baseRevision = nextReview.revision; entry.dirty = !equal(entry.value, value);
        } else if (targetsEditor && nextReview.revision > confirmed.appliedRevision) {
          entry.baseValue = confirmed.pending.args.feedback === null ? emptyFeedback() : clone(confirmed.pending.args.feedback); entry.baseRevision = confirmed.appliedRevision; entry.dirty = !equal(entry.value, value);
          if (!entry.dirty) loadEditor(entry, value, nextReview.revision);
        }
      });
      return true;
    }
    function stale(record, entry) { return !!(entry && entry.dirty && record.review && entry.baseRevision !== record.review.revision); }
    function draw() {
      if (disposed) return;
      var record = currentRecord(), entry = currentEditor(), validJob = job && job.snapshot && job.snapshot.capabilityId === "image.edit", selected = validJob && (job.results || []).find(function (candidate) { return candidate.resultId === resultId; });
      panel.hidden = !validJob || !selected; if (panel.hidden || !record) return;
      var key = JSON.stringify([scopeKey && typeof scopeKey === "string" ? scopeKey : "", job.jobId, resultId]);
      if (displayKey !== key || displayVersion !== entry.uiVersion) { displayKey = key; displayVersion = entry.uiVersion; paintFields(record, entry); }
      var acceptedId = record.review && record.review.acceptance && record.review.acceptance.resultId, ownAccepted = acceptedId === resultId;
      var acceptedIndex = (job.results || []).findIndex(function (candidate) { return candidate.resultId === acceptedId; });
      var candidateIndex = (job.results || []).findIndex(function (candidate) { return candidate.resultId === resultId; });
      status.textContent = "候选 " + (candidateIndex + 1) + " · " + (!record.review ? record.loading ? "正在读取审阅…" : "审阅尚未读取" : ownAccepted ? "已采用此候选" : acceptedId ? acceptedIndex >= 0 ? "当前采用候选 " + (acceptedIndex + 1) : "已采用另一候选" : "尚未采用") + (entry.dirty ? " · 反馈有未保存修改" : "");
      var waiting = !!record.pending, ready = !!record.review && record.verifiedEpoch === epoch, blocked = busy || !ready || waiting || !!record.conflict;
      ui.setDisabled(accept, blocked || ownAccepted); ui.setDisabled(clearAcceptance, blocked || !acceptedId);
      ui.setDisabled(previous, busy || !record.previous); previous.hidden = !record.previous;
      ui.setDisabled(addItem, !ready || entry.value.items.length >= 20); ui.setDisabled(addPreserve, !ready || entry.value.preserve.length >= 20);
      ui.setDisabled(save, blocked || !entry.dirty || stale(record, entry));
      var hasSaved = record.review && record.review.feedback.some(function (item) { return item.resultId === resultId; });
      ui.setDisabled(remove, blocked || !hasSaved || stale(record, entry));
      reload.textContent = entry.dirty ? "舍弃编辑并载入最新反馈" : "重新读取审阅"; ui.setDisabled(reload, waiting || record.loading);
      retry.hidden = !waiting || record.pending.attempting; ui.setDisabled(retry, !waiting || record.pending.attempting || busy);
      message.textContent = waiting && record.pending.attempting ? record.pending.reconciling ? "正在核对上次保存…" : record.pending.operation === "setAcceptedResult" ? "正在保存采用选择…" : "正在保存反馈…" : record.notice;
      message.hidden = !message.textContent; error.textContent = record.error; error.hidden = !record.error;
      var hasConflict = !!record.conflict || stale(record, entry); conflict.hidden = !hasConflict;
      nodes.studioReviewConflictText.textContent = hasConflict ? "共享审阅已更新。本地编辑仍保留；请对照下方最新反馈，或舍弃编辑后重新载入。" : "";
      if (hasConflict) {
        var saved = savedFeedback(record.review, resultId), lines = saved.items.map(function (item, index) { return (index + 1) + ". " + (item.area ? item.area + "：" : "") + item.description + (item.requestedChange ? "\n修改建议：" + item.requestedChange : ""); });
        saved.preserve.forEach(function (item) { lines.push("保留：" + item); });
        nodes.studioReviewCurrentFeedback.textContent = "最新已保存反馈\n" + (lines.length ? lines.join("\n\n") : "此候选尚无已保存反馈。");
      }
    }

    function active(record, ticket) { return !disposed && epoch === ticket && scope && scope.get(record.jobId) === record && scopeKey === record.scopeKey; }
    function readRecord(record, transport, settings) {
      settings = settings || {}; if (record.read) return record.read;
      var ticket = epoch, sequence = ++record.sequence; record.loading = true; draw();
      var read = Promise.resolve().then(function () { if (!active(record, ticket) || record.sequence !== sequence) return null; return transport.call("getJobReview", { jobId: record.jobId }); }).then(function (value) {
        if (!active(record, ticket) || record.sequence !== sequence) return false;
        if (!validRead(value, record.jobId)) throw failure("TRANSPORT_PROTOCOL_ERROR");
        if (ingest(record, value.review)) { record.previous = clone(value.previousAccepted); record.verifiedEpoch = ticket; }
        if (!record.pending && !record.conflict) record.error = "";
        return true;
      }).catch(function () {
        if (!active(record, ticket) || record.sequence !== sequence) return false;
        record.error = settings.confirmed ? "保存已确认，但最新审阅读取失败。请检查连接后重新读取。" : settings.reconciling ? "暂时无法核对上次保存。请检查连接后再次核对；原保存仍待确认。" : "无法读取候选审阅，请检查连接后重新读取。";
        return false;
      }).then(function (success) {
        if (active(record, ticket) && record.sequence === sequence) { record.loading = false; record.read = null; draw(); }
        return success;
      });
      record.read = read; return read;
    }
    function refresh() {
      if (disposed || !job || !resultId) return Promise.resolve(false);
      var transport = bindScope(), record = currentRecord(); if (!record || !transport || typeof transport.call !== "function") return Promise.resolve(false);
      return readRecord(record, transport);
    }
    function discardAndReload() {
      var transport = bindScope(), record = currentRecord(), entry = currentEditor(); if (!record || !entry || record.pending) return Promise.resolve(false);
      var ticket = epoch, id = resultId, version = entry.version;
      return readRecord(record, transport).then(function (success) {
        if (!success || !active(record, ticket)) return false;
        // Discard only the edit the user chose, never text entered while the read was pending.
        if (entry.version === version) { loadEditor(entry, savedFeedback(record.review, id), record.review.revision); record.conflict = null; record.error = ""; record.notice = "已载入最新反馈。"; }
        else record.notice = "已读取最新审阅，读取期间输入的文字仍保留。";
        draw(); return true;
      });
    }
    function clearOldReads(record) { record.sequence++; record.read = null; record.loading = false; }
    function begin(operation, selectedId, deleting) {
      var transport = bindScope(), record = currentRecord(), entry = currentEditor();
      if (!record || !entry || !record.review || record.verifiedEpoch !== epoch || record.pending || record.conflict || busy) return Promise.resolve(false);
      if (operation === "updateResultFeedback" && stale(record, entry)) { draw(); return Promise.resolve(false); }
      var feedback = deleting ? null : feedbackValue(entry.value);
      if (operation === "updateResultFeedback" && !deleting && !validFeedback(feedback)) { localFailure("请填写每条问题描述和保留项。最多各 20 项；区域限 120 字，描述和建议各限 2000 字，保留项限 500 字，反馈总长度也需缩短到允许范围。"); return Promise.resolve(false); }
      var args = { jobId: record.jobId, resultId: selectedId, expectedReviewRevision: operation === "updateResultFeedback" ? entry.baseRevision : record.review.revision, requestId: requestId() };
      if (operation === "updateResultFeedback") args.feedback = feedback;
      record.pending = { operation: operation, args: freeze(clone(args)), editorVersion: entry.version, attempting: false, reconciling: false, uncertain: false };
      record.error = ""; record.notice = ""; return attempt(record, transport, false);
    }
    function uncertain(record, label) { record.pending.uncertain = true; record.error = label || "保存尚未确认，可能已经写入。请核对上次保存后再修改共享审阅。"; record.notice = ""; }
    function writeFailure(record, errorValue, pending) {
      var code = errorValue && errorValue.code;
      // Store deduplication precedes CAS atomically. A valid newer revision
      // conflict on the exact request proves it never applied; an early
      // service refusal or malformed response cannot prove that fact.
      if (code === "REVIEW_REVISION_CONFLICT") {
        var details = errorValue.details;
        if (details && details.jobId === record.jobId && validReview(details.current) && details.current.revision > pending.args.expectedReviewRevision) {
          ingest(record, details.current); record.pending = null; record.conflict = { current: clone(record.review) };
          record.error = pending.uncertain ? "已核对：上次保存未写入，共享审阅已被更新。本地编辑仍保留。" : "共享审阅已被更新，未保存这次修改。本地编辑仍保留。";
        } else uncertain(record);
        return;
      }
      // A refusal before store deduplication says nothing about an earlier
      // attempt whose ACK was lost. Preserve its original request journal.
      if (pending.uncertain) {
        uncertain(record, code === "SERVICE_CLOSING" ? "服务正在关闭，上次保存仍待确认。连接恢复后请继续核对上次保存。" : "暂时无法确认上次保存，原保存可能已写入。请检查连接或任务存储后继续核对，不能作为新修改重复提交。");
        return;
      }
      var labels = { INVALID_INPUT: "反馈格式不符合要求，请检查字段长度和内容。", JOB_NOT_FOUND: "原任务已不可用，请重新读取任务列表。", RESULT_NOT_FOUND: "所选候选已不可用，请重新读取任务列表。", CAPABILITY_CONFLICT: "此任务不支持候选审阅。", STATE_CONFLICT: "当前审阅无法继续写入，请检查任务存储。", STORAGE_CORRUPT: "任务存储无法读取，未保存这次修改。请检查 Companion 的任务存储。", STORAGE_FULL: "任务存储空间不足，未保存这次修改。", SERVICE_CLOSING: "服务正在关闭，本次保存尚未开始。连接恢复后请重新读取。" };
      if (Object.prototype.hasOwnProperty.call(labels, code)) { record.pending = null; record.error = labels[code]; return; }
      uncertain(record, code === "REQUEST_CONFLICT" ? "上次保存的请求记录不一致。请先核对原保存，不能作为新修改重复提交。" : null);
    }
    function attempt(record, transport, reconciling) {
      var pending = record.pending, ticket = epoch;
      if (!pending || pending.attempting || transportKey(transport) !== record.scopeKey) return Promise.resolve(false);
      clearOldReads(record); pending.attempting = true; pending.reconciling = reconciling; record.error = ""; draw();
      return Promise.resolve().then(function () { if (!active(record, ticket) || record.pending !== pending) return null; return transport.call(pending.operation, pending.args); }).then(function (value) {
        if (!active(record, ticket) || record.pending !== pending) return false;
        if (!validAck(value, pending)) throw failure("TRANSPORT_UNCERTAIN");
        clearOldReads(record); record.pending = null; record.conflict = null;
        ingest(record, value.review, { pending: pending, appliedRevision: value.appliedRevision }); record.verifiedEpoch = ticket;
        record.error = ""; record.notice = value.duplicate && value.review.revision > value.appliedRevision ? "上次保存已确认；当前显示后续更新后的共享审阅。" : pending.operation === "setAcceptedResult" ? pending.args.resultId === null ? "已取消采用。" : "已记录采用选择。" : pending.args.feedback === null ? "已删除此候选的反馈。" : "反馈已保存。";
        draw(); return readRecord(record, transport, { confirmed: true }).then(function () { return true; });
      }).catch(function (errorValue) {
        if (!active(record, ticket) || record.pending !== pending) return false;
        writeFailure(record, errorValue, pending); return false;
      }).then(function (success) {
        if (active(record, ticket) && record.pending === pending) pending.attempting = false;
        if (active(record, ticket)) draw(); return success;
      });
    }
    function reconcile() {
      var transport = bindScope(), record = currentRecord(), pending = record && record.pending, ticket = epoch;
      if (!pending || pending.attempting || busy) return Promise.resolve(false);
      pending.attempting = true; pending.reconciling = true; record.error = ""; draw();
      return readRecord(record, transport, { reconciling: true }).then(function (success) {
        if (!active(record, ticket) || record.pending !== pending) return false;
        pending.attempting = false;
        if (!success) { draw(); return false; }
        // Read-back cannot prove which request wrote the state. Only the original ACK can.
        return attempt(record, transport, true);
      });
    }
    function navigatePrevious() {
      var record = currentRecord(), previousValue = record && record.previous, ticket = epoch; if (!previousValue || busy) return Promise.resolve(false);
      return Promise.resolve().then(function () { if (!active(record, ticket)) return false; return options.onSelectResult(previousValue.jobId, previousValue.resultId); }).then(function (selected) {
        if (active(record, ticket) && selected === false) { record.error = "此前采用的候选暂不可用。请重新读取任务列表后再试。"; draw(); }
        return selected;
      }).catch(function () { if (active(record, ticket)) { record.error = "无法打开此前采用的候选。请重新读取任务列表后再试。"; draw(); } return false; });
    }
    function render(next) {
      if (disposed) return; bindScope(); job = next && next.job || null; resultId = next && next.resultId || null; busy = !!(next && next.busy);
      if (job && job.snapshot && job.snapshot.capabilityId === "image.edit") recordFor(job);
      draw();
    }
    function reset() { invalidate(); scope = null; scopeKey = null; job = null; resultId = null; displayKey = ""; displayVersion = -1; panel.hidden = true; clearFields(items); clearFields(preserve); }
    panel.hidden = true; nodes.studioReviewItemFields = []; nodes.studioReviewPreserveFields = [];
    return { nodes: nodes, render: render, refresh: refresh, reset: reset, dispose: function () { reset(); disposed = true; sessions.clear(); if (panel.parentElement) panel.parentElement.removeChild(panel); } };
  }
  var api = { mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_STUDIO_REVIEW = api;
})(typeof window !== "undefined" ? window : null);
