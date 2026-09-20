/* Write-only BYOK form. Secrets stay in the password field until submission;
 * they are never added to shared drafts, localStorage or public UI state. */
(function (root) {
  "use strict";
  function mount(options) {
    var doc = options.document || options.window.document, ui = options.ui, transport = options.transport, parent = options.parent, nodes = {}, config = null, busy = false, disposed = false, sequence = 0;
    function node(tag, className, text, id, into) { var el = doc.createElement(tag); el.className = className || ""; if (text != null) el.textContent = text; if (id) { el.id = id; nodes[id] = el; } (into || frame).appendChild(el); return el; }
    var frame = doc.createElement("div"); frame.className = "sec studio-provider-settings"; parent.appendChild(frame);
    node("h3", "", "图像服务 · Gemini");
    node("p", "studio-note", "使用独立的图像服务 API Key。环境变量优先于本地设置；修改只影响之后提交的任务。");
    function field(id, label, type) {
      var wrap = node("label", "studio-field"), labelNode = node("span", "studio-field-label", label, null, wrap), input = node("input", "studio-input", null, id, wrap);
      input.type = type || "text"; input.setAttribute("aria-label", label); input.setAttribute("autocomplete", "off");
      input.addEventListener("focus", function () { wrap.classList.add("is-focused"); }); input.addEventListener("blur", function () { wrap.classList.remove("is-focused"); });
      return input;
    }
    var endpoint = field("providerEndpoint", "Gemini API 地址"), model = field("providerDefaultModel", "默认图像模型"), timeout = field("providerTimeout", "请求超时（毫秒）", "number"), key = field("providerApiKey", "API Key（留空保留原值）", "password");
    endpoint.placeholder = "https://generativelanguage.googleapis.com"; model.placeholder = "gemini-2.5-flash-image"; timeout.min = "1"; timeout.max = "600000"; timeout.step = "1000";
    var source = node("div", "studio-note", "", "providerSources"), keyStatus = node("div", "studio-note", "", "providerKeyStatus"), status = node("div", "studio-message", "", "providerNotice"); status.setAttribute("role", "status");
    var failure = node("div", "studio-error", "", "providerError"); failure.setAttribute("role", "alert");
    var actions = node("div", "studio-row");
    function button(id, label, fn) { var el = ui.createButton("studio-button ghost", label, function () { if (!busy && !disposed) Promise.resolve(fn()).catch(function () {}); }); el.id = id; nodes[id] = el; actions.appendChild(el); return el; }
    var save = button("providerSave", "保存配置", function () { return submit(false); }), clear = button("providerClearKey", "删除本地 Key", function () { return submit(true); }), reload = button("providerReload", "重新载入", load);
    function controls() {
      var sources = config && config.sources || {};
      endpoint.disabled = busy || !config || sources.baseUrl === "environment";
      model.disabled = busy || !config || sources.model === "environment";
      timeout.disabled = busy || !config || sources.timeoutMs === "environment";
      key.disabled = busy || !config || sources.apiKey === "environment";
      ui.setDisabled(save, busy || !config); ui.setDisabled(clear, busy || !config || !config.hasLocalApiKey); ui.setDisabled(reload, busy);
    }
    function render(value) {
      config = value; key.value = "";
      endpoint.value = value.baseUrl; model.value = value.model; timeout.value = String(value.timeoutMs);
      var names = { baseUrl: "地址", model: "模型", timeoutMs: "超时", apiKey: "Key" }, labels = { environment: "环境变量", local: "本地保存", default: "默认" };
      source.textContent = Object.keys(names).map(function (name) { return names[name] + "：" + labels[value.sources[name]]; }).join(" · ");
      keyStatus.textContent = value.hasApiKey ? "已提供 Key；在线鉴权和模型可用性尚未验证。" : "尚未提供 Key，图像生成不可用。";
      key.placeholder = value.sources.apiKey === "environment" ? "由环境变量提供" : value.hasLocalApiKey ? "已保存；输入新值可替换" : "输入 API Key";
      failure.textContent = value.configurationError ? value.configurationError.message : "";
      controls();
    }
    function fail(error) { if (!disposed) { failure.textContent = error && error.message || "配置操作失败，请重新载入核对。"; status.textContent = ""; } }
    async function load() {
      if (disposed || busy) return;
      busy = true; key.value = ""; status.textContent = "读取配置…"; failure.textContent = ""; controls(); var current = ++sequence;
      try {
        var value = await transport.getProviderSettings();
        if (disposed || current !== sequence) return;
        render(value); status.textContent = "本地配置已载入；未发送生成请求。";
      } catch (error) { if (current === sequence) fail(error); throw error; }
      finally { if (current === sequence) { busy = false; controls(); } }
    }
    async function submit(clearKey) {
      if (disposed || busy || !config) return;
      var patch = { expectedRevision: config.revision }, sources = config.sources;
      if (clearKey) patch.clearApiKey = true;
      else {
        if (sources.baseUrl !== "environment") patch.baseUrl = endpoint.value.trim();
        if (sources.model !== "environment") patch.model = model.value.trim();
        if (sources.timeoutMs !== "environment") patch.timeoutMs = Number(timeout.value);
        if (sources.apiKey !== "environment" && key.value.trim()) patch.apiKey = key.value;
      }
      key.value = ""; busy = true; status.textContent = "保存配置…"; failure.textContent = ""; controls(); var current = ++sequence;
      try {
        var value = await transport.updateProviderSettings(patch);
        if (disposed || current !== sequence) return;
        render(value); status.textContent = clearKey ? "本地 Key 已删除。" : "配置已保存；未发送生成请求。";
        if (clearKey && value.sources.apiKey === "environment") status.textContent += " 当前仍使用环境变量中的 Key。";
        if (options.onSaved) await options.onSaved();
      } catch (error) { if (current === sequence) fail(error); throw error; }
      finally { delete patch.apiKey; if (current === sequence) { busy = false; controls(); } }
    }
    controls();
    return { nodes: nodes, load: load, save: function () { return submit(false); }, clearKey: function () { return submit(true); }, dispose: function () { disposed = true; sequence++; key.value = ""; config = null; if (frame.parentElement) frame.parentElement.removeChild(frame); } };
  }
  var api = { mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_PROVIDER_SETTINGS = api;
})(typeof window !== "undefined" ? window : null);
