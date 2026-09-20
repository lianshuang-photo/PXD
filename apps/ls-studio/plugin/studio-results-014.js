/* Candidate inspection is bound exclusively to the selected job snapshot. */
(function (root) {
  "use strict";
  function mount(options) {
    var doc = options.document, ui = options.ui, nodes = {}, state = null, job = null, resultId = null, mode = "split", zoom = 1, signature = "", generation = 0, disposed = false, cache = new Map();
    function node(tag, className, text, parent, id) { var el = doc.createElement(tag); el.className = className || ""; if (text != null) el.textContent = text; if (id) { el.id = id; nodes[id] = el; } if (parent) parent.appendChild(el); return el; }
    function button(parent, id, text, action) { var el = ui.createButton("studio-button ghost", text, function () { try { Promise.resolve(action()).catch(options.onError); } catch (error) { options.onError(error); } }); el.id = id; nodes[id] = el; parent.appendChild(el); return el; }
    var panel = node("div", "studio-comparison", null, options.parent, "studioComparison");
    node("div", "studio-note", "", panel, "studioCompareOrigin");
    var actions = node("div", "studio-row", null, panel);
    var original = button(actions, "studioCompareOriginalDraft", "从原输入另建草稿", function () { return options.onDerive(job.jobId, "original"); });
    var refine = button(actions, "studioCompareRevisionDraft", "以候选作参考另建草稿", function () { return options.onDerive(job.jobId, "candidate-reference", resultId); });
    node("div", "studio-note", "新草稿沿用原任务的参数与回贴设置；候选仅作参考。修改指令后再生成。", panel);
    var controls = node("div", "studio-row", null, panel);
    [["source", "A 原输入"], ["result", "B 候选"], ["split", "并排"]].forEach(function (item) { button(controls, "studioCompareMode_" + item[0], item[1], function () { mode = item[0]; layout(); }); });
    var select = node("select", "studio-input studio-compare-select", null, controls, "studioCompareCandidate"); select.setAttribute("aria-label", "对比候选图");
    select.addEventListener("change", function () { selectResult(job && job.jobId, select.value); });
    var zooms = node("div", "studio-row", null, panel);
    [[1, "适应"], [2, "放大 2×"], [4, "放大 4×"]].forEach(function (item) { button(zooms, "studioCompareZoom_" + item[0], item[1], function () { zoom = item[0]; layout(); }); });
    button(zooms, "studioCompareRetry", "重新读取图像", function () { cache.clear(); signature = ""; render(state); });
    var images = node("div", "studio-compare-images", null, panel, "studioCompareImages");
    function side(key, label) {
      var wrap = node("div", "studio-compare-side", null, images, "studioCompareSide_" + key);
      node("div", "studio-note", label, wrap);
      var viewport = node("div", "studio-compare-viewport", null, wrap);
      var image = node("img", "studio-compare-image", null, viewport, "studioCompareImage_" + key); image.alt = label;
      var status = node("div", "studio-note", "", wrap, "studioCompareStatus_" + key); status.setAttribute("role", "status");
      return { wrap: wrap, image: image, status: status, label: label };
    }
    var sourceSide = side("source", "A · 此任务的原输入"), resultSide = side("result", "B · 所选候选"), sides = [sourceSide, resultSide];
    function layout() {
      sourceSide.wrap.hidden = mode === "result"; resultSide.wrap.hidden = mode === "source";
      ["source", "result", "split"].forEach(function (value) { nodes["studioCompareMode_" + value].setAttribute("aria-pressed", String(mode === value)); });
      [1, 2, 4].forEach(function (value) { nodes["studioCompareZoom_" + value].setAttribute("aria-pressed", String(zoom === value)); });
      sides.forEach(function (side) { side.image.style.width = (zoom * 100) + "%"; side.image.style.maxWidth = zoom === 1 ? "100%" : "none"; side.image.style.maxHeight = zoom === 1 ? "var(--s240, 240px)" : "none"; });
    }
    function clearImage(side) { side.image.hidden = true; side.image.removeAttribute("src"); side.image.onload = null; side.image.onerror = null; }
    function read(side, assetId, ticket) {
      clearImage(side);
      if (!assetId) { side.status.textContent = side.label + "：未保存图像资产"; return; }
      side.status.textContent = "读取图像…";
      if (!cache.has(assetId)) {
        if (cache.size >= 4) cache.delete(cache.keys().next().value);
        var request;
        try { request = options.readAsset(assetId); } catch (error) { request = Promise.reject(error); }
        var pending = Promise.resolve(request).catch(function (error) { if (cache.get(assetId) === pending) cache.delete(assetId); throw error; });
        cache.set(assetId, pending);
      }
      function current() { return !disposed && generation === ticket; }
      cache.get(assetId).then(function (data) {
        if (!current()) return;
        side.image.onload = function () { if (current()) side.status.textContent = side.image.naturalWidth && side.image.naturalHeight ? side.image.naturalWidth + " × " + side.image.naturalHeight : "图像已读取"; };
        side.image.onerror = function () { if (current()) { clearImage(side); side.status.textContent = "图像无法显示；请重新读取，或检查资产是否完整。"; } };
        side.image.src = data; side.image.hidden = false; side.status.textContent = "图像已读取";
      }).catch(function (error) { if (current()) { clearImage(side); side.status.textContent = side.label + "无法读取：" + (error.message || "资产不存在或已损坏") + "。可点击重新读取。"; } });
    }
    function render(next) {
      if (disposed || !next) return;
      state = next;
      var nextJob = next.jobs.find(function (item) { return item.jobId === next.selectedJobId; });
      if (!job || !nextJob || job.jobId !== nextJob.jobId) { resultId = null; mode = "split"; zoom = 1; }
      job = nextJob;
      panel.hidden = !job || !job.snapshot || job.snapshot.capabilityId !== "image.edit";
      if (panel.hidden) { generation++; signature = ""; sides.forEach(clearImage); return; }
      var results = job.results || [], selected = results.find(function (item) { return item.resultId === resultId; });
      if (!selected) { selected = results[0]; resultId = selected ? selected.resultId : null; }
      var context = job.snapshot.context;
      nodes.studioCompareOrigin.textContent = "任务 " + job.jobId + " · 原草稿 r" + job.snapshot.revision + " · 原输入与候选对比";
      ui.setDisabled(original, !!next.busy || !!next.dirty); ui.setDisabled(refine, !!next.busy || !!next.dirty || !selected);
      var choices = JSON.stringify(results.map(function (item) { return item.resultId; }));
      if (select._choices !== choices) {
        select._choices = choices; while (select.firstChild) select.removeChild(select.firstChild);
        results.forEach(function (item, index) { var option = node("option", "", "候选 " + (index + 1), select); option.value = item.resultId; });
      }
      select.value = resultId || ""; select.disabled = !selected;
      var nextSignature = JSON.stringify([job.jobId, context && context.baseAssetId, selected && selected.assetId]);
      if (nextSignature !== signature) {
        signature = nextSignature; var ticket = ++generation;
        read(sourceSide, context && context.baseAssetId, ticket); read(resultSide, selected && selected.assetId, ticket);
      }
      layout();
    }
    function selectResult(jobId, selectedId) {
      if (!job || job.jobId !== jobId || !job.results.some(function (item) { return item.resultId === selectedId; })) return;
      resultId = selectedId; render(state);
    }
    function reset() { generation++; signature = ""; state = null; job = null; resultId = null; cache.clear(); sides.forEach(clearImage); panel.hidden = true; }
    reset();
    return { render: render, selectResult: selectResult, nodes: nodes, reset: reset, dispose: function () { disposed = true; reset(); if (panel.parentElement) panel.parentElement.removeChild(panel); } };
  }
  var api = { mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_STUDIO_RESULTS = api;
})(typeof window !== "undefined" ? window : null);
