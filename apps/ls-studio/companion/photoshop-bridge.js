"use strict";
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { tools, validate } = require("./photoshop-tools");
const { DomainError, hostOperations, validateSchema, clone } = require("./domain/contracts");

class PhotoshopBridge extends EventEmitter {
  constructor(options = {}) {
    super(); this.host = null; this.jobs = new Map(); this.toolToken = randomUUID();
    this.leaseMs = options.leaseMs || 25000; this.timeoutMs = options.timeoutMs || 30000;
    this.monitor = setInterval(() => { if (this.host && Date.now() - this.host.seen > this.leaseMs) this.disconnect(); }, 2000);
    this.monitor.unref();
  }
  status() { return { connected: !!this.host && Date.now() - this.host.seen <= this.leaseMs, host: this.host && this.host.name, version: this.host && this.host.version, tools: tools.map(t => t.name) }; }
  register(body) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(body.clientId || "")) throw new Error("Photoshop 客户端编号无效");
    if (this.host && this.host.clientId === body.clientId) { this.host.seen = Date.now(); return { hostToken: this.host.token }; }
    this.disconnect();
    this.host = { clientId: body.clientId, token: randomUUID(), name: "Photoshop", version: String(body.version || "").slice(0,40), seen: Date.now() };
    this.emit("change"); return { hostToken: this.host.token };
  }
  authorize(clientId, token) {
    if (!this.host || this.host.clientId !== clientId || token !== this.host.token) throw new Error("Photoshop 连接已更新，请重新注册");
    this.host.seen = Date.now();
  }
  take(clientId, token) {
    this.authorize(clientId, token);
    const job = [...this.jobs.values()].find(j => !j.delivered);
    if (!job) return null;
    job.delivered = true;
    return { id: job.id, tool: job.tool, arguments: job.args, expiresAt: job.expiresAt };
  }
  request(name, args, options = {}) {
    args = hostOperations[name] ? clone(validateSchema(args, hostOperations[name])) : validate(name, args);
    if (name === "photoshop_capabilities") return Promise.resolve({ ok: true, ...this.status() });
    if (!this.status().connected) return Promise.reject(new DomainError("HOST_UNAVAILABLE", "Photoshop 未连接。请打开 Photoshop 并加载 LS Studio 面板。", 503));
    if (this.jobs.size >= 8) return Promise.reject(new Error("Photoshop 正在处理其他请求，请稍后重试"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => { if (options.signal) options.signal.removeEventListener("abort", aborted); };
      const aborted = () => {
        const job = this.jobs.get(id);
        // Once delivered, allow the host to report its actual receipt. Cancellation
        // cannot erase a mutation that may already have run inside Photoshop.
        if (job && !job.delivered) { clearTimeout(job.timer); this.jobs.delete(id); cleanup(); reject(new DomainError("CANCELLED", "Photoshop 请求已取消")); }
      };
      const timer = setTimeout(() => { const job = this.jobs.get(id); this.jobs.delete(id); cleanup(); reject(new DomainError(job && job.delivered && hostOperations[name] ? "HOST_UNCERTAIN" : "HOST_TIMEOUT", "Photoshop 工具响应超时；请核对宿主状态", 504)); }, this.timeoutMs);
      this.jobs.set(id, { id, tool: name, args, delivered: false, resolve, reject, timer, cleanup, expiresAt: Date.now() + this.timeoutMs });
      if (options.signal) { options.signal.addEventListener("abort", aborted, { once: true }); if (options.signal.aborted) aborted(); }
      this.emit("job");
    });
  }
  result(body, token) {
    this.authorize(body.clientId, token);
    const job = this.jobs.get(body.id);
    if (!job || !job.delivered) throw new Error("工具请求已结束或尚未领取");
    const result = body.result;
    if (!result || typeof result.ok !== "boolean") throw new Error("Photoshop 返回格式无效");
    clearTimeout(job.timer); this.jobs.delete(job.id); job.cleanup();
    if (result.ok) job.resolve(result); else job.reject(new DomainError(typeof result.code === "string" ? result.code : "HOST_EXECUTION_FAILED", String(result.error || "Photoshop 执行失败").slice(0,600), 409));
    console.log(JSON.stringify({ time: new Date().toISOString(), event: "photoshop.tool", tool: job.tool, ok: result.ok }));
  }
  disconnect() {
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.cleanup(); job.reject(new DomainError(job.delivered && hostOperations[job.tool] ? "HOST_UNCERTAIN" : "HOST_UNAVAILABLE", "Photoshop 连接已中断，本次工具请求未完成", 503)); }
    this.jobs.clear();
    if (this.host) { this.host = null; this.emit("change"); this.emit("job"); }
  }
  close() { clearInterval(this.monitor); this.disconnect(); }
}
module.exports = { PhotoshopBridge };
