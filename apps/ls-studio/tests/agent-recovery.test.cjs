const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element extends EventTarget {
  constructor() {
    super(); this.children = []; this.attributes = {}; this.value = ''; this.textContent = '';
    this.style = {}; this.className = ''; this.scrollHeight = 0; this.clientHeight = 0; this.scrollTop = 0;
    const classes = new Set();
    this.classList = { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n), toggle: (n, on) => on ? classes.add(n) : classes.delete(n) };
  }
  get firstChild() { return this.children[0]; }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  focus() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function client({ up = true, storage = new Map() } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), elements = new Map(), requests = [], waiting = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => new Element() };
  const window = new EventTarget();
  window.PXD_CONTEXT = { isPhotoshop: true, read: async () => ({ open: false }) };
  window.PXD_MARKDOWN = { render: (node, text) => { node.textContent = text; } };
  const server = {
    up, hangMessage: false, handshakeFailures: 0, epoch: 'runtime-a', version: 0,
    connection: { status: 'offline', authenticated: false, model: 'test-model', models: [] },
    session: { id: 'session-a', items: [], requests: [], status: 'idle' },
  };
  const snapshot = () => JSON.parse(JSON.stringify({ ok: true, epoch: server.epoch, version: server.version, connection: server.connection, session: server.session }));
  const response = body => ({ ok: body.ok !== false, status: body.ok === false ? 500 : 200, json: async () => body });
  const fetch = (url, options) => {
    const route = new URL(url).pathname;
    requests.push({ route, body: options.body && JSON.parse(options.body) });
    if (!server.up) return Promise.reject(new Error('connection refused'));
    if (route === '/agent/session') return Promise.resolve(response(snapshot()));
    if (route === '/agent/connect') {
      if (server.handshakeFailures-- > 0) return Promise.resolve(response({ ok: false, error: 'fixture handshake failed' }));
      server.connection = { ...server.connection, status: 'ready', authenticated: true }; server.version++;
      return Promise.resolve(response(snapshot()));
    }
    if (route === '/agent/message' && !server.hangMessage) return Promise.resolve(response(snapshot()));
    return new Promise((resolve, reject) => waiting.push({ route, resolve, reject }));
  };
  const context = vm.createContext({
    window, document, navigator: {}, Event, fetch,
    // Deliberately no AbortController: exercise the UXP fallback too.
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval: () => {},
  });
  for (const script of ['ui-014.js', 'composer-014.js', 'agent-014.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin', script), 'utf8'), context);
  return {
    server, element, window, requests, storage, waiting, snapshot,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = until; await flush();
    },
    emit(value) { const i = waiting.findIndex(r => r.route === '/agent/events'); assert.ok(i >= 0); waiting.splice(i, 1)[0].resolve(response(value)); },
    draft(text) { element('prompt').value = text; element('prompt').dispatchEvent(new Event('input')); },
    disabled() { return window.PXD_UI.isDisabled(element('go')); },
    count(route) { return requests.filter(r => r.route === route).length; },
  };
}

test('service starts after panel: reconnects automatically and preserves a draft without submitting it', async () => {
  const f = client({ up: false }); await flush(); f.draft('你现在能帮我做什么？');
  assert.equal(f.disabled(), true);
  assert.match(f.element('agentError').textContent, /本机服务/);
  f.server.up = true; await f.advance(2500);
  assert.equal(f.disabled(), false);
  assert.equal(f.element('agentError').hidden, true);
  assert.equal(f.element('prompt').value, '你现在能帮我做什么？');
  assert.equal(f.count('/agent/message'), 0);
  const reloaded = client({ storage: f.storage }); await flush();
  assert.equal(reloaded.element('prompt').value, '你现在能帮我做什么？');
});

test('failed handshake retries even when a session snapshot already exists', async () => {
  const f = client(); f.server.handshakeFailures = 1; await flush();
  assert.equal(f.disabled(), true);
  assert.match(f.element('agentError').textContent, /handshake failed/);
  await f.advance(2500);
  assert.equal(f.disabled(), false);
  assert.equal(f.count('/agent/connect'), 2);
});

test('Codex child exit while HTTP stays alive triggers another handshake', async () => {
  const f = client(); await flush(); f.draft('保留草稿');
  f.server.connection.status = 'offline'; f.server.connection.authenticated = false; f.server.version++;
  f.emit({ ...f.snapshot(), reset: true }); await flush();
  assert.equal(f.count('/agent/connect'), 2);
  assert.equal(f.disabled(), false);
  assert.equal(f.element('prompt').value, '保留草稿');
  assert.equal(f.count('/agent/message'), 0);
});

test('hung long poll times out in UXP, recovers a new epoch, and ignores its late response', async () => {
  const f = client(); await flush(); f.draft('不要重发');
  const stale = f.waiting.shift();
  await f.advance(28000);
  assert.equal(f.disabled(), true);
  f.server.epoch = 'runtime-b'; f.server.version = 0;
  await f.advance(2500);
  assert.equal(f.disabled(), false);
  stale.resolve({ ok: true, json: async () => ({ ...f.snapshot(), epoch: 'old', connection: { status: 'offline' }, reset: true }) });
  await flush();
  assert.equal(f.disabled(), false);
  assert.equal(f.count('/agent/message'), 0);
  assert.equal(f.element('prompt').value, '不要重发');
});

test('lost message response never auto-resubmits; explicit retry uses the same receipt ID', async () => {
  const f = client(); await flush(); f.draft('测试一条消息');
  f.server.hangMessage = true;
  const first = f.window.PXD_AGENT.send(); await flush();
  await f.advance(45000); await first;
  assert.equal(f.count('/agent/message'), 1);
  assert.equal(f.element('prompt').value, '测试一条消息');
  f.server.hangMessage = false;
  await f.window.PXD_AGENT.send();
  const ids = f.requests.filter(r => r.route === '/agent/message').map(r => r.body.clientMessageId);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(f.element('prompt').value, '');
  assert.equal(f.storage.get('pxdls.agent.draft'), '');
});
