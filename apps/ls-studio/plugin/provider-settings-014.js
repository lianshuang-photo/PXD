/* Write-only BYOK form. Secrets stay in the password field until submission;
 * they are never added to shared drafts, localStorage or public UI state. */
(function (root) {
  "use strict";
  function checkedSettings(value) {
    var sources = value && value.sources;
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.baseUrl !== "string" || typeof value.model !== "string" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 600000 || typeof value.hasApiKey !== "boolean" || typeof value.hasLocalApiKey !== "boolean" || !sources || !["baseUrl", "model", "timeoutMs", "apiKey"].every(function (name) { return ["environment", "local", "default"].indexOf(sources[name]) >= 0; })) {
      var error = new Error("本机服务未返回有效配置。"); error.code = "INVALID_RESPONSE"; throw error;
    }
    return value;
  }
  function failureMessage(error, action, confirmed) {
    if (confirmed) return (action === "clear" ? "本地 Key 已删除" : "配置已保存") + "，但工作区状态未刷新。请重新载入工作区核对。";
    var code = error && error.code, reading = action === "load", outcome = action === "clear" ? "本地 Key 是否已删除" : "配置是否已保存";
    if (code === "NETWORK_ERROR") return reading ? "无法连接本机服务，未能读取配置。请检查服务和连接地址，然后重新载入。" : "连接中断，" + outcome + "尚未确认。请重新载入配置核对后再操作。";
    if (code === "INVALID_RESPONSE") return reading ? "本机服务未返回有效配置。请检查服务和连接地址，然后重新载入。" : "未收到有效配置，" + outcome + "尚未确认。请重新载入配置核对后再操作。";
    if (code === "CONFIG_REVISION_CONFLICT") return "配置已被其他窗口修改。请重新载入最新配置后再操作。";
    if (code === "CONFIG_OVERRIDDEN") return "部分设置由本机服务的环境变量提供，不能在此修改。请重新载入查看当前配置。";
    // These settings errors occur before update writes the configuration.
    if (code === "CONFIG_STORAGE_CORRUPT") return "本地配置文件无法读取或内容无效，本次请求未修改配置。请检查文件内容和读取权限，修复后重新载入。";
    if (code === "CAPABILITY_UNAVAILABLE") return "当前本机服务未提供图像服务设置功能，本次请求未修改配置。请检查连接地址和服务版本后重新载入。";
    if (code === "BODY_TOO_LARGE") return "配置请求超过服务的大小限制，本次请求未修改配置。" + (reading ? "请检查本机服务和连接地址后重新载入。" : "请检查输入内容，移除误粘贴的长文本后再操作。");
    // Storage errors can happen after rename, while flushing the directory.
    if (code === "CONFIG_STORAGE_UNAVAILABLE") return reading ? "本机配置存储暂时不可用。请检查目录权限或磁盘状态，再重新载入。" : "本机配置存储出现错误，" + outcome + "尚未确认。请检查目录权限或磁盘状态，再重新载入配置核对。";
    if (code === "INVALID_INPUT" || code === "INVALID_CONFIGURATION") return "配置内容无效，请检查 API 地址、模型、Key 和超时设置。";
    if (code === "PROVIDER_NOT_CONFIGURED") return "图像服务配置未就绪，请检查 API 地址、模型、Key 和超时设置。";
    // Do not display raw error text: even an invalid response may contain a key.
    return reading ? "读取配置失败。请检查本机服务后重新载入。" : outcome + "尚未确认。请重新载入配置核对后再操作。";
  }
  function safeFailure(error, action, confirmed) {
    var known = ["NETWORK_ERROR", "INVALID_RESPONSE", "CONFIG_REVISION_CONFLICT", "CONFIG_OVERRIDDEN", "CONFIG_STORAGE_CORRUPT", "CAPABILITY_UNAVAILABLE", "BODY_TOO_LARGE", "CONFIG_STORAGE_UNAVAILABLE", "INVALID_INPUT", "INVALID_CONFIGURATION", "PROVIDER_NOT_CONFIGURED"];
    var candidate = error && error.code, code = known.indexOf(candidate) >= 0 ? candidate : "CONFIG_OPERATION_FAILED";
    // The parent workspace also renders rejected promises. Keep raw messages,
    // unknown codes, details and causes out of that caller-facing error too.
    var safe = new Error(failureMessage({ code: code }, action, confirmed)); safe.code = code; return safe;
  }
  function mount(options) {
    var doc = options.document || options.window.document, ui = options.ui, transport = options.transport, parent = options.parent, nodes = {}, config = null, busy = false, disposed = false, sequence = 0;
    function node(tag, className, text, id, into) { var el = doc.createElement(tag); el.className = className || ""; if (text != null) el.textContent = text; if (id) { el.id = id; nodes[id] = el; } (into || frame).appendChild(el); return el; }
    var frame = doc.createElement("div"); frame.className = "sec studio-provider-settings"; parent.appendChild(frame);
    node("h3", "", "图像服务 · Gemini");
    node("p", "studio-note", "配置 Gemini 图像生成服务。保存不会生成图片；新设置只用于之后的任务。由环境变量提供的项目不能在此修改。");
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
      config = checkedSettings(value); key.value = "";
      endpoint.value = value.baseUrl; model.value = value.model; timeout.value = String(value.timeoutMs);
      var names = { baseUrl: "地址", model: "模型", timeoutMs: "超时", apiKey: "Key" }, labels = { environment: "环境变量", local: "本地保存", default: "默认" };
      source.textContent = Object.keys(names).map(function (name) { return names[name] + "：" + labels[value.sources[name]]; }).join(" · ");
      keyStatus.textContent = value.hasApiKey ? "已提供 Key；在线鉴权和模型可用性尚未验证。" : "尚未提供 Key，图像生成不可用。";
      key.placeholder = value.sources.apiKey === "environment" ? "由环境变量提供" : value.hasLocalApiKey ? "已保存；输入新值可替换" : "输入 API Key";
      failure.textContent = value.configurationError ? failureMessage(value.configurationError, "load") : "";
      controls();
    }
    function fail(error) { if (!disposed) { failure.textContent = error.message; status.textContent = ""; } }
    async function load() {
      if (disposed || busy) return;
      busy = true; key.value = ""; status.textContent = "读取配置…"; failure.textContent = ""; controls(); var current = ++sequence;
      try {
        var value = await transport.getProviderSettings();
        if (disposed || current !== sequence) return;
        render(value); status.textContent = "图像服务配置已载入。";
      } catch (error) { var safe = safeFailure(error, "load"); if (current === sequence) fail(safe); throw safe; }
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
      key.value = ""; busy = true; status.textContent = clearKey ? "删除本地 Key…" : "保存配置…"; failure.textContent = ""; controls(); var current = ++sequence, confirmed = false;
      try {
        var value = await transport.updateProviderSettings(patch);
        if (disposed || current !== sequence) return;
        render(value); confirmed = true; status.textContent = clearKey ? "本地 Key 已删除。" : "配置已保存。";
        if (clearKey && value.sources.apiKey === "environment") status.textContent += " 当前仍使用环境变量中的 Key。";
        if (options.onSaved) await options.onSaved();
      } catch (error) { var safe = safeFailure(error, clearKey ? "clear" : "save", confirmed); if (current === sequence) fail(safe); throw safe; }
      finally { delete patch.apiKey; if (current === sequence) { busy = false; controls(); } }
    }
    controls();
    return { nodes: nodes, load: load, save: function () { return submit(false); }, clearKey: function () { return submit(true); }, dispose: function () { disposed = true; sequence++; key.value = ""; config = null; if (frame.parentElement) frame.parentElement.removeChild(frame); } };
  }
  var api = { mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_PROVIDER_SETTINGS = api;
})(typeof window !== "undefined" ? window : null);
