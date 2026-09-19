"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { CodexAgent, safeText, fail } = require("./codex-agent");

function localHost(name) { return ["localhost", "127.0.0.1", "[::1]"].includes(name); }
function allowedOrigin(origin) {
  if (!origin || origin === "null" || origin === "file://" || origin.startsWith("uxp://")) return true;
  try { const u = new URL(origin); return ["http:", "https:"].includes(u.protocol) && localHost(u.hostname); } catch (_) { return false; }
}
function bodyJson(req, maxBytes = 24 * 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return Promise.reject(fail("需要 JSON 请求", 415));
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], rejected = false;
    req.on("data", c => {
      size += c.length;
      if (size > maxBytes) { if (!rejected) reject(fail("请求附件超过大小限制", 413)); rejected = true; chunks = []; }
      if (!rejected) chunks.push(c);
    });
    req.on("end", () => { if (rejected) return; try { const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); if (!b || Array.isArray(b) || typeof b !== "object") throw Error(); resolve(b); } catch (_) { reject(fail("JSON 格式无效")); } });
    req.on("error", reject);
  });
}
function createAgentHttp(options = {}) {
  const agent = options.agent || new CodexAgent(options);
  const pluginDir = options.pluginDir || path.join(__dirname, "../plugin");
  async function handle(req, res, url) {
    const name = url.pathname;
    if (!(name === "/ui" || name.startsWith("/ui/") || name.startsWith("/agent/") || name.startsWith("/photoshop/"))) return false;
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Headers": "Content-Type, X-PXDLS-Agent, X-PXDLS-Host, X-PXDLS-Tool", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    function json(status, value) { const text = JSON.stringify(value); res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) }); res.end(text); }
    try {
      const requestHost = new URL("http://" + req.headers.host).hostname;
      if (!localHost(requestHost) || !allowedOrigin(req.headers.origin)) { json(403, { ok: false, error: "仅允许本机 LS Studio 访问 Agent" }); return true; }
      if (req.headers.origin) headers["Access-Control-Allow-Origin"] = req.headers.origin;
      if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return true; }
      if (name === "/ui" || name.startsWith("/ui/")) {
        if (req.method !== "GET") throw fail("页面仅支持 GET", 405);
        if (name === "/ui") { res.writeHead(302, { ...headers, Location: "/ui/" }); res.end(); return true; }
        let file = name === "/ui" || name === "/ui/" ? "index.html" : decodeURIComponent(name.slice(4));
        if (!/^(?:[a-zA-Z0-9_-]+\.(?:js|css|html)|icons\/[a-zA-Z0-9_.-]+\.(?:svg|png))$/.test(file)) throw fail("页面不存在", 404);
        let content = fs.readFileSync(path.join(pluginDir, file));
        // The browser uses exactly the panel UI, with the PS-only entry scripts omitted.
        if (file === "index.html") content = Buffer.from(content.toString("utf8").replace(/\s*<script src="ps-(?:encode|capture|return)-014\.js"><\/script>/g, ""));
        const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
        res.writeHead(200, { ...headers, "Content-Type": types[path.extname(file)], "Content-Length": content.length }); res.end(content); return true;
      }
      const asset = /^\/agent\/assets\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/.exec(name);
      if (asset && req.method === "GET") {
        const data = fs.readFileSync(path.join(agent.workspace, "attachments", asset[1]));
        res.writeHead(200, { ...headers, "Content-Type": asset[1].endsWith(".jpg") ? "image/jpeg" : "image/" + path.extname(asset[1]).slice(1), "Content-Length": data.length }); res.end(data); return true;
      }
      if (req.headers["x-pxdls-agent"] !== "1") throw fail("缺少 LS Studio 客户端标识", 403);
      if (name.startsWith("/photoshop/")) {
        const bridge = agent.photoshop, origin = req.headers.origin;
        if (name === "/photoshop/status" && req.method === "GET") { json(200, { ok: true, ...bridge.status() }); return true; }
        if (name === "/photoshop/call" && req.method === "POST") {
          if (req.headers["x-pxdls-tool"] !== bridge.toolToken) throw fail("工具连接凭据无效", 403);
          const body = await bodyJson(req);
          if (typeof body.tool !== "string" || body.tool.startsWith("studio_")) throw fail("生产操作必须通过共享能力服务", 403);
          json(200, await bridge.request(body.tool, body.arguments)); return true;
        }
        // Web previews are clients, never Photoshop executors. UXP has an opaque origin.
        if (origin && origin !== "null" && origin !== "file://" && !origin.startsWith("uxp://")) throw fail("仅 Photoshop 插件可连接执行器", 403);
        if (name === "/photoshop/register" && req.method === "POST") json(200, { ok: true, ...bridge.register(await bodyJson(req)) });
        else if (name === "/photoshop/heartbeat" && req.method === "POST") {
          const body = await bodyJson(req); bridge.authorize(body.clientId, req.headers["x-pxdls-host"]); json(200, { ok: true });
        }
        else if (name === "/photoshop/result" && req.method === "POST") {
          bridge.result(await bodyJson(req, 96 * 1024 * 1024), req.headers["x-pxdls-host"]); json(200, { ok: true });
        } else if (name === "/photoshop/jobs" && req.method === "GET") {
          const client = url.searchParams.get("clientId"), token = req.headers["x-pxdls-host"];
          const job = bridge.take(client, token);
          if (job) json(200, { ok: true, job });
          else {
            let timer;
            const cleanup = () => { clearTimeout(timer); bridge.removeListener("job", changed); res.removeListener("close", cleanup); };
            const changed = () => {
              cleanup(); if (res.destroyed) return;
              try { json(200, { ok: true, job: bridge.take(client, token) }); }
              catch (e) { json(409, { ok: false, error: e.message }); }
            };
            timer = setTimeout(changed, 12000); bridge.on("job", changed); res.on("close", cleanup);
          }
        } else throw fail("Photoshop 接口不存在", 404);
        return true;
      }
      if (req.method === "GET" && name === "/agent/session") json(200, { ok: true, ...agent.snapshot() });
      else if (req.method === "GET" && name === "/agent/sessions") json(200, { ok: true, sessions: agent.listSessions() });
      else if (req.method === "GET" && name === "/agent/events") {
        const after = Number(url.searchParams.get("after"));
        const epoch = url.searchParams.get("epoch");
        const result = agent.poll(after, epoch);
        if (result.reset || result.events.length) json(200, result);
        else {
          let timer;
          const cleanup = () => { clearTimeout(timer); agent.removeListener("change", changed); };
          const changed = () => { cleanup(); if (!res.destroyed) json(200, agent.poll(after, epoch)); };
          timer = setTimeout(changed, 20000);
          agent.on("change", changed); res.on("close", cleanup);
        }
      } else if (req.method === "POST") {
        const body = await bodyJson(req);
        if (name === "/agent/connect") json(200, { ok: true, ...await agent.connect() });
        else if (name === "/agent/message") json(200, await agent.send(body));
        else if (name === "/agent/interrupt") json(200, await agent.interrupt());
        else if (name === "/agent/answer") json(200, agent.answer(body));
        else if (name === "/agent/session/new") json(200, agent.switchSession());
        else if (name === "/agent/session/resume") json(200, agent.switchSession(body.id));
        else throw fail("Agent 接口不存在", 404);
      } else throw fail("Agent 接口不存在", 404);
    } catch (e) { json(e.status || (e.code === "ENOENT" ? 404 : 500), { ok: false, error: safeText(e.message) }); }
    return true;
  }
  return { agent, handle };
}
module.exports = { createAgentHttp, allowedOrigin };
