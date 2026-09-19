/* Codex conversation client. JSON long-polling works in UXP without ReadableStream. */
(function () {
  "use strict";
  var ui = window.PXD_UI, md = window.PXD_MARKDOWN;
  var $ = function (id) { return document.getElementById(id); };
  var state = null, version = -1, nodes = {}, dirty = {}, renderTimer = null;
  var connecting = false, sending = false, companionConnected = false, alive = true, pollGeneration = 0;
  var attachments = [], modelChoice = "", effortChoice = "", lastRequestSignature = "", modelSignature = "";
  var localError = "", connectionError = "", pendingSubmission = null;
  try { pendingSubmission = JSON.parse(localStorage.getItem("pxdls.agent.pending") || "null"); } catch (_) {}
  var compose = $("prompt"), scroll = $("th");
  try { if (!compose.value) compose.value = localStorage.getItem("pxdls.agent.draft") || ""; } catch (_) {}
  function saveDraft() { try { localStorage.setItem("pxdls.agent.draft", compose.value); } catch (_) {} }
  var nativeInput = window.PXD_CONTEXT.isPhotoshop;
  var enterSends = true;
  try { enterSends = localStorage.getItem("pxdls.enter-send") !== "false"; } catch (_) {}
  function paintEnter() {
    $("enterSend").textContent = enterSends ? "开启" : "关闭"; $("enterSend").setAttribute("aria-pressed", String(enterSends));
    document.querySelector(".agent-key-hint").textContent = enterSends ? (nativeInput ? "Enter 发送 · ↵ 换行" : "Enter 发送 · Shift 换行") : "Enter 换行 · ↑ 发送";
  }
  $("enterSend").addEventListener("click", function () { enterSends = !enterSends; try { localStorage.setItem("pxdls.enter-send", String(enterSends)); } catch (_) {} paintEnter(); });
  paintEnter();
  function base() { return ($("baseUrl").value.trim() || "http://127.0.0.1:17880").replace(/\/+$/, ""); }
  function removeChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, cls, text) { var node = document.createElement(tag); node.className = cls; if (text != null) node.textContent = text; return node; }
  function busy() { return sending || (state && ["starting", "running", "waiting", "stopping"].indexOf(state.session.status) >= 0); }
  function paintError() {
    var message = connectionError || localError || (state && (state.session.error || state.connection.storageError || (state.connection.status !== "ready" && state.connection.error))) || "";
    $("agentError").textContent = message; $("agentError").hidden = !message;
  }
  function error(message) { localError = message || ""; paintError(); }
  function rememberSubmission(value) {
    pendingSubmission = value;
    try { if (value) localStorage.setItem("pxdls.agent.pending", JSON.stringify(value)); else localStorage.removeItem("pxdls.agent.pending"); } catch (_) {}
  }
  function endScroll() { scroll.scrollTop = scroll.scrollHeight; }
  function nearBottom() { return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 65; }
  async function api(route, body) {
    var options = { method: body === undefined ? "GET" : "POST", headers: { "X-PXDLS-Agent": "1" } };
    if (body !== undefined) { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) options.signal = controller.signal;
    var timer, timeout = route.indexOf("/agent/events") === 0 ? 28000 : (body === undefined ? 8000 : 45000);
    // The race also bounds UXP runtimes without AbortController. Timed-out POSTs
    // are never retried here; send() retains the original message receipt ID.
    var deadline = new Promise(function (_, reject) { timer = setTimeout(function () {
      var e = new Error("本机服务响应超时"); e.transport = true; reject(e);
      if (controller) controller.abort();
    }, timeout); });
    try {
      return await Promise.race([deadline, (async function () {
        var response;
        try { response = await fetch(base() + route, options); } catch (e) { e.transport = true; throw e; }
        var result; try { result = await response.json(); } catch (_) { var e = new Error("Companion 返回了无法读取的响应，请重新连接"); e.transport = true; throw e; }
        if (!response.ok || result.ok === false) throw new Error(result.error || "连接失败（" + response.status + "）");
        return result;
      })()]);
    } finally { clearTimeout(timer); }
  }
  async function copy(text, button) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else if (navigator.clipboard && navigator.clipboard.setContent) await navigator.clipboard.setContent({ "text/plain": text });
      else throw new Error();
      button.textContent = "已复制"; setTimeout(function () { button.textContent = "复制"; }, 1600);
    } catch (_) { error("无法自动复制，请选中文本后复制。"); }
  }
  function copyButton(text) { var button = ui.createButton("agent-copy", "复制", function () { copy(text, button); }); return button; }
  async function openLink(href) {
    if (!/^https?:\/\//.test(href)) { error("文件路径：" + href); return; }
    try {
      if (window.PXD_CONTEXT.isPhotoshop) await require("uxp").shell.openExternal(href);
      else window.open(href, "_blank", "noopener,noreferrer");
    } catch (_) { error("链接：" + href); }
  }
  var markdownOptions = { openLink: openLink, codeButton: copyButton };
  function queueItem(item) {
    dirty[item.id] = item;
    if (!renderTimer) renderTimer = setTimeout(flushItems, 100);
  }
  function flushItems() {
    renderTimer = null;
    var follow = nearBottom();
    Object.keys(dirty).forEach(function (id) { renderItem(dirty[id]); }); dirty = {};
    if (follow) endScroll();
  }
  function renderItem(item) {
    var entry = nodes[item.id];
    if (!entry) {
      var node = el("div", "agent-item agent-" + item.type);
      var head = el("div", "agent-item-head"), label = el("span", "agent-item-label"), body = el("div", "agent-item-body");
      head.appendChild(label); node.appendChild(head); node.appendChild(body);
      $("agentMessages").appendChild(node);
      entry = nodes[item.id] = { node: node, head: head, label: label, body: body, text: null, status: null, expanded: false };
    }
    entry.node.setAttribute("data-status", item.status || "completed");
    if (item.type === "user" || item.type === "assistant") {
      entry.label.textContent = item.type === "user" ? (item.status === "failed" ? "你 · 发送失败" : "你") : (item.phase === "commentary" ? "CODEX · 进展" : "CODEX");
      if (entry.text !== item.text) {
        entry.text = item.text;
        if (item.type === "user") entry.body.textContent = item.text;
        else md.render(entry.body, item.text || "", markdownOptions);
      }
      if (item.attachments && !entry.attachments) {
        entry.attachments = el("div", "agent-message-images");
        item.attachments.forEach(function (a) { var image = el("img", "agent-message-image"); image.src = base() + a.url; image.alt = a.name; entry.attachments.appendChild(image); });
        entry.node.appendChild(entry.attachments);
      }
      if (item.type === "assistant" && item.status === "completed" && item.text && !entry.copy) { entry.copy = copyButton(item.text); entry.head.appendChild(entry.copy); }
    } else if (item.type === "activity") {
      entry.label.textContent = item.status === "inProgress" ? "正在思考…" : (item.status === "interrupted" ? "思考已停止" : "思考完成");
      entry.body.hidden = true;
    } else if (item.type === "plan") {
      entry.label.textContent = item.title || "执行计划";
      var planText = item.text || "";
      if (item.steps) planText += "\n" + item.steps.map(function (s) { return "- [" + (s.status === "completed" ? "x" : " ") + "] " + s.step; }).join("\n");
      if (entry.text !== planText) { entry.text = planText; md.render(entry.body, planText, markdownOptions); }
    } else {
      var finished = item.status !== "inProgress", failed = ["failed", "declined", "interrupted"].indexOf(item.status) >= 0;
      entry.label.textContent = (failed ? "! " : finished ? "✓ " : "◌ ") + (item.title || "工具") + (item.durationMs ? " · " + (item.durationMs / 1000).toFixed(1) + "s" : "");
      if (!entry.toggle) {
        entry.toggle = ui.createButton("agent-tool-toggle", "展开", function () { entry.expanded = !entry.expanded; entry.body.hidden = !entry.expanded; entry.toggle.textContent = entry.expanded ? "收起" : "展开"; });
        entry.head.appendChild(entry.toggle); entry.body.hidden = true;
      }
      var detail = [item.detail, item.output, item.exitCode != null ? "退出码：" + item.exitCode : ""].filter(Boolean).join("\n\n");
      if (entry.text !== detail) { entry.text = detail; entry.body.textContent = detail || (finished ? "已完成" : "执行中…"); }
      if (item.previews && !entry.previews) {
        entry.previews = el("div", "agent-tool-previews");
        item.previews.forEach(function (a) { var img = el("img", "agent-tool-preview"); img.src = base() + a.url; img.alt = a.name; entry.previews.appendChild(img); });
        entry.node.appendChild(entry.previews);
      }
    }
  }
  function snapshot(result, force) {
    if (result.version < version && state && result.epoch === state.epoch && result.session.id === state.session.id && !result.reset) return;
    var reset = force || result.reset || !state || result.epoch !== state.epoch || result.session.id !== state.session.id;
    state = { epoch: result.epoch, connection: result.connection, session: result.session };
    version = result.version;
    if (reset) { removeChildren($("agentMessages")); nodes = {}; dirty = {}; lastRequestSignature = ""; }
    state.session.items.forEach(queueItem);
    paintState();
  }
  function paintState() {
    var connected = state && state.connection.status === "ready", running = busy();
    var authenticated = connected && state.connection.authenticated;
    var model = modelChoice || (state && (state.session.model || state.connection.model));
    $("agentStatus").textContent = connected && companionConnected ? (authenticated ? "Codex · " + (model || "已连接") : "Codex · 待登录") : (connecting ? "连接 Codex…" : "Codex · 未连接");
    $("agentDot").classList.toggle("on", !!authenticated && companionConnected);
    $("agentConnectionHint").textContent = !companionConnected ? "本机服务未连接，正在自动恢复" : connected ? (authenticated ? "已连接本机 Codex" : "请在终端运行 codex login") : "正在恢复 Codex 连接";
    var ps = state && state.connection.photoshop;
    $("photoshopStatus").textContent = companionConnected && ps && ps.connected ? "已连接 PS " + ps.version + " · 可读取文档与图层" : "未连接，请在 Photoshop 中打开 LS Studio";
    var skills = state && state.connection.skills || [];
    $("agentSkillsStatus").textContent = skills.length ? skills.map(function (s) { return s.name + (s.enabled ? " · 可用" : " · 已禁用"); }).join("\n") : (state && state.connection.skillError || "等待 Codex 检查 Skill");
    ui.setDisabled($("go"), !authenticated || !companionConnected || sending || (running && (!state.session.turnId || state.session.status === "stopping")));
    $("go").textContent = running ? "■" : "↑";
    $("go").setAttribute("aria-label", running ? "停止执行" : "发送消息");
    $("go").title = running ? "停止执行" : "发送消息";
    ui.setDisabled($("agentNew"), running); ui.setDisabled($("agentHistory"), running);
    ui.setDisabled($("agentModelToggle"), running || !connected);
    var hasMessages = state && state.session.items.length > 0;
    $("agentWelcome").hidden = !!hasMessages; $("emptyChips").hidden = !!hasMessages;
    var statuses = { starting: "连接会话…", running: "Codex 正在处理…", waiting: "需要你的回应", stopping: "正在停止…", interrupted: "已停止，可继续发送消息" };
    var progress = state && statuses[state.session.status];
    $("agentProgress").textContent = progress || ""; $("agentProgress").hidden = !progress;
    paintError();
    paintRequests(); paintModels();
  }
  function paintModels() {
    if (!state) return;
    var models = state.connection.models || [], current = modelChoice || state.session.model || state.connection.model || "";
    $("agentModelLabel").textContent = current || "跟随本机 Codex 设置";
    var signature = JSON.stringify([models, current, effortChoice, state.session.effort, state.connection.effort]);
    if (signature === modelSignature) return; modelSignature = signature;
    removeChildren($("agentModelList"));
    models.forEach(function (m) {
      var b = ui.createButton("agent-model-option" + (m.id === current ? " is-on" : ""), m.name || m.id, function () {
        if (busy()) return;
        modelChoice = m.id; effortChoice = ""; $("agentModelList").hidden = true; paintState();
      }); $("agentModelList").appendChild(b);
    });
    removeChildren($("agentEfforts"));
    var selected = models.find(function (m) { return m.id === current; });
    var effort = effortChoice || state.session.effort || state.connection.effort || "";
    if (selected && selected.efforts.indexOf(effort) < 0) effort = selected.efforts.indexOf("medium") >= 0 ? "medium" : selected.efforts[0];
    (selected ? selected.efforts : []).forEach(function (e) {
      var labels = { none: "无", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高", ultra: "极高" };
      var b = ui.createButton("agent-effort" + (e === effort ? " is-on" : ""), labels[e] || e, function () { if (busy()) return; effortChoice = e; paintModels(); });
      $("agentEfforts").appendChild(b);
    });
  }
  function paintRequests() {
    var requests = state ? state.session.requests || [] : [], signature = JSON.stringify(requests);
    if (signature === lastRequestSignature) return;
    lastRequestSignature = signature; removeChildren($("agentRequests"));
    requests.forEach(function (request) {
      var card = el("div", "agent-request"), p = request.params, fields = {};
      card.appendChild(el("div", "agent-request-title", request.method.indexOf("requestUserInput") >= 0 ? "Codex 需要补充信息" : "Codex 请求执行操作"));
      async function answer(decision) {
        var answers = {}; Object.keys(fields).forEach(function (id) { answers[id] = fields[id].value; });
        try { await api("/agent/answer", { sessionId: state.session.id, epoch: state.epoch, requestId: request.id, decision: decision, answers: answers }); error(""); } catch (e) { error(e.message); }
      }
      if (request.method === "item/tool/requestUserInput") {
        (p.questions || []).forEach(function (q) {
          card.appendChild(el("div", "agent-request-question", q.question));
          var input = el("textarea", "agent-answer"); input.setAttribute("aria-label", q.question); fields[q.id] = input;
          if (q.options) q.options.forEach(function (option) { card.appendChild(ui.createButton("agent-answer-option", option.label, function () { input.value = option.label; })); });
          card.appendChild(input);
        });
        card.appendChild(ui.createButton("red", "提交回答", function () { answer("accept"); }));
      } else {
        card.appendChild(el("div", "agent-request-reason", p.reason || p.message || "请确认这次操作"));
        var item = state.session.items.find(function (i) { return i.id === p.itemId; });
        card.appendChild(el("pre", "agent-request-detail", [p.command || (p.permissions ? JSON.stringify(p.permissions, null, 2) : p.grantRoot || (item && item.detail) || ""), p.cwd ? "目录：" + p.cwd : ""].filter(Boolean).join("\n")));
        var buttons = el("div", "agent-request-actions");
        if (request.method !== "mcpServer/elicitation/request") buttons.appendChild(ui.createButton("red", "仅允许这次", function () { answer("accept"); }));
        buttons.appendChild(ui.createButton("ghost", request.method === "mcpServer/elicitation/request" ? "取消此工具请求" : "拒绝", function () { answer("decline"); })); card.appendChild(buttons);
      }
      $("agentRequests").appendChild(card);
    });
  }
  async function poll(generation) {
    var first = true;
    while (alive && generation === pollGeneration) {
      try {
        // A live HTTP server does not imply a live Codex child process. Restore
        // either layer, including after a failed initial handshake or restart.
        if (first || !state || !companionConnected || state.connection.status !== "ready") {
          connecting = true; paintState();
          var current = await api("/agent/session");
          if (!alive || generation !== pollGeneration) return;
          snapshot(current); companionConnected = true;
          current = await api("/agent/connect", {});
          if (!alive || generation !== pollGeneration) return;
          snapshot(current); connecting = false; connectionError = ""; first = false; paintState();
        }
        var result = await api("/agent/events?after=" + version + "&epoch=" + encodeURIComponent(state ? state.epoch : ""));
        if (!alive || generation !== pollGeneration) return;
        if (result.reset || (state && (result.epoch !== state.epoch || result.sessionId !== state.session.id)) || (result.events || []).some(function (e) { return e.type === "reset"; })) {
          var refreshed = result.reset ? result : await api("/agent/session");
          if (!alive || generation !== pollGeneration) return;
          snapshot(refreshed, true);
        } else if (result.version > version) {
          (result.events || []).forEach(function (event) {
            if (event.seq <= version) return;
            if (event.type === "state") { state.connection = event.connection; state.session = Object.assign({}, state.session, event.session); }
            if (event.type === "item") {
              var i = state.session.items.findIndex(function (i) { return i.id === event.item.id; });
              if (i < 0) state.session.items.push(event.item); else state.session.items[i] = event.item;
              queueItem(event.item);
            }
          }); version = result.version;
        }
        companionConnected = true; connectionError = ""; paintState();
      } catch (e) {
        if (generation !== pollGeneration || !alive) return;
        connecting = false;
        if (e.transport) companionConnected = false;
        connectionError = e.transport ? "本机服务暂时不可用，正在自动重连。草稿已保留，消息不会自动重发。" : "Codex 连接暂未恢复：" + e.message;
        paintState();
        await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      }
    }
  }
  function connect() {
    if (connecting) return;
    connecting = true; connectionError = ""; error(""); paintState();
    poll(++pollGeneration);
  }
  async function readContext() {
    try {
      var context = await window.PXD_CONTEXT.read();
      $("ctx").textContent = context.open ? context.name + (context.selection ? " · 选区 " + context.selection.width + "×" + context.selection.height : " · 无选区") : (window.PXD_CONTEXT.isPhotoshop ? "无活动文档" : "浏览器预览");
      return { host: window.PXD_CONTEXT.isPhotoshop ? "photoshop" : "browser", document: context, capturedAt: new Date().toISOString() };
    } catch (_) { $("ctx").textContent = "文档信息暂不可读"; return null; }
  }
  async function send() {
    if (busy() || !state || !compose.value.trim()) return;
    if (!companionConnected || state.connection.status !== "ready") { error("连接恢复后即可发送，草稿已保留。"); return; }
    if (!state.connection.authenticated) { error("请先连接并登录 Codex"); return; }
    sending = true; error(""); paintState();
    var text = compose.value.trim(), sentImages = attachments.slice();
    var sessionId = state.session.id;
    var id = pendingSubmission && pendingSubmission.sessionId === sessionId && pendingSubmission.text === text ? pendingSubmission.id : "ls_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
    rememberSubmission({ id: id, sessionId: sessionId, text: text });
    try {
      var context = await readContext();
      var result = await api("/agent/message", { sessionId: sessionId, clientMessageId: id, text: text, context: context, images: sentImages, model: modelChoice || undefined, effort: effortChoice || undefined });
      snapshot(result);
      rememberSubmission(null);
      if (compose.value.trim() === text) { compose.value = ""; saveDraft(); composer.sync(); }
      attachments = attachments.filter(function (a) { return sentImages.indexOf(a) < 0; }); paintAttachments();
      endScroll();
    } catch (e) { error(e.message + "。可重新连接查看结果；重试同一条消息会沿用原消息编号。"); }
    finally { sending = false; paintState(); compose.focus(); }
  }
  function paintAttachments() {
    var box = $("agentAttachments"); removeChildren(box); box.hidden = attachments.length === 0;
    attachments.forEach(function (a, i) {
      var wrap = el("div", "agent-attachment"); var image = el("img", "agent-attachment-image"); image.src = a.url; image.alt = a.name; wrap.appendChild(image);
      wrap.appendChild(ui.createButton("agent-attachment-remove", "×", function () { attachments.splice(i, 1); paintAttachments(); })); box.appendChild(wrap);
    });
  }
  function attach(url, name) {
    if (attachments.length >= 4) { error("每次最多附 4 张图片"); return; }
    if (url.length > 16 * 1024 * 1024) { error("图片过大，请使用较小的 PNG／JPEG／WebP"); return; }
    attachments.push({ url: url, name: name || "图片" }); paintAttachments();
  }
  function fileData(file) { return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = reject; reader.readAsDataURL(file); }); }
  async function attachFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (!/^image\/(png|jpeg|webp)$/.test(files[i].type)) continue;
      try { attach(await fileData(files[i]), files[i].name); } catch (_) { error("图片读取失败"); }
    }
  }
  $("go").addEventListener("click", async function () {
    if (ui.isDisabled($("go"))) return;
    if (busy()) { try { snapshot(await api("/agent/interrupt", {})); } catch (e) { error(e.message); } } else send();
  });
  var composer = window.PXD_COMPOSER.attach({ field: compose, frame: $("promptFrame"), document: document, native: nativeInput, enterSends: function () { return enterSends; }, send: send, saveDraft: saveDraft,
    onEvent: function (type) { if (nativeInput && typeof console !== "undefined") console.log("[ls.composer] " + type); } });
  $("agentNewline").addEventListener("click", composer.newline);
  compose.addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); attachFiles(files); }
  });
  document.querySelectorAll("#emptyChips .human-chip").forEach(function (b) { b.addEventListener("click", function () { compose.value = b.getAttribute("data-send"); send(); }); });
  $("agentReconnect").addEventListener("click", connect);
  $("compRetry").addEventListener("click", connect);
  $("baseUrl").addEventListener("change", function () { pollGeneration++; connecting = false; companionConnected = false; state = null; version = -1; connect(); });
  $("agentNew").addEventListener("click", async function () {
    if (busy()) return;
    try { modelChoice = ""; effortChoice = ""; snapshot(await api("/agent/session/new", {})); error(""); compose.value = ""; saveDraft(); attachments = []; paintAttachments(); compose.focus(); } catch (e) { error(e.message); }
  });
  $("agentHistory").addEventListener("click", async function () {
    if (busy()) return;
    var list = $("agentHistoryList"); list.hidden = !list.hidden; if (list.hidden) return;
    try {
      var result = await api("/agent/sessions"); removeChildren(list);
      result.sessions.forEach(function (s) { list.appendChild(ui.createButton("agent-history-option", s.title, async function () {
        try { modelChoice = ""; effortChoice = ""; snapshot(await api("/agent/session/resume", { id: s.id })); list.hidden = true; error(""); compose.value = ""; saveDraft(); attachments = []; paintAttachments(); } catch (e) { error(e.message); }
      })); });
    } catch (e) { error(e.message); }
  });
  $("agentModelToggle").addEventListener("click", function () { if (!busy()) $("agentModelList").hidden = !$("agentModelList").hidden; });
  $("agentAttachSelection").hidden = !window.PXD_CONTEXT.isPhotoshop;
  $("agentAttachSelection").addEventListener("click", async function () {
    ui.setDisabled($("agentAttachSelection"), true);
    try { var image = await window.PXD_CONTEXT.captureSelection(); attach("data:image/png;base64," + image.base64, "PS 选区 " + image.width + "×" + image.height); error(""); }
    catch (e) { error(String(e.message).indexOf("NO_SELECTION") >= 0 ? "请先在 Photoshop 中画出选区" : e.message); }
    finally { ui.setDisabled($("agentAttachSelection"), false); }
  });
  $("agentAttachFile").addEventListener("click", async function () {
    if (!window.PXD_CONTEXT.isPhotoshop) { $("agentFile").click(); return; }
    try {
      var storage = require("uxp").storage;
      var files = await storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"], allowMultiple: true });
      if (!files) return; if (!Array.isArray(files)) files = [files];
      for (var i = 0; i < files.length; i++) {
        var bytes = await files[i].read({ format: storage.formats.binary });
        var kind = /\.webp$/i.test(files[i].name) ? "webp" : /\.png$/i.test(files[i].name) ? "png" : "jpeg";
        attach("data:image/" + kind + ";base64," + window.psEncode.arrayBufferToBase64(bytes), files[i].name);
      }
    } catch (e) { error(e.message || "图片读取失败"); }
  });
  $("agentFile").addEventListener("change", async function () { await attachFiles($("agentFile").files); $("agentFile").value = ""; });
  window.PXD_AGENT = { send: send, connect: connect };
  var contextTimer = setInterval(readContext, 4000);
  window.addEventListener("unload", function () { saveDraft(); composer.close(); alive = false; pollGeneration++; clearInterval(contextTimer); if (renderTimer) clearTimeout(renderTimer); });
  readContext(); connect();
})();
