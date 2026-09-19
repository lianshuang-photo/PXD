const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { CodexAgent } = require('../companion/codex-agent');
const { createAgentHttp } = require('../companion/agent-http');

// Exercise real newline-delimited JSON-RPC over streams, without a paid model.
class AppServerFixture {
  constructor() { this.calls = []; this.processes = []; this.turns = 0; this.rejectTurn = false; }
  spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.stdin = new Writable({ write: (data, _, cb) => {
      for (const line of String(data).trim().split('\n')) {
        const msg = JSON.parse(line); this.calls.push(msg);
        queueMicrotask(() => this.handle(proc, msg));
      }
      cb();
    }});
    proc.kill = () => { queueMicrotask(() => proc.emit('exit', null, 'SIGTERM')); };
    this.processes.push(proc); return proc;
  };
  write(proc, msg) { proc.stdout.write(JSON.stringify(msg) + '\n'); }
  notify(method, params, proc = this.processes.at(-1)) { this.write(proc, { method, params }); }
  handle(proc, msg) {
    if (msg.id == null || !msg.method) return;
    let result = {};
    if (msg.method === 'initialize') result = { userAgent: 'fixture/1' };
    if (msg.method === 'account/read') result = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    if (msg.method === 'config/read') result = { config: { model: 'model-a', model_reasoning_effort: 'high' } };
    if (msg.method === 'model/list') result = { data: [{ model: 'model-a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') result = { thread: { id: msg.params.threadId || 'thread-a', turns: msg.method === 'thread/resume' ? (this.resumeTurns || []) : [] }, model: 'model-a', reasoningEffort: 'high' };
    if (msg.method === 'turn/start') {
      if (this.rejectTurn) { this.write(proc, { id: msg.id, error: { code: -1, message: 'model rejected request' } }); return; }
      result = { turn: { id: 'turn-' + (++this.turns), status: 'inProgress' } };
      this.notify('turn/started', { threadId: msg.params.threadId, turn: result.turn }, proc);
    }
    if (msg.method === 'turn/interrupt') this.notify('turn/completed', { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: 'interrupted' } }, proc);
    this.write(proc, { id: msg.id, result });
  }
  count(method) { return this.calls.filter(c => c.method === method).length; }
}
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-agent-test-'));
  const fixture = new AppServerFixture();
  const agent = new CodexAgent({ dataDir, spawn: fixture.spawn });
  t.after(() => { agent.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const message = (extra = {}) => ({ sessionId: agent.session.id, clientMessageId: 'message-0001', text: '测试', ...extra });
  return { agent, fixture, dataDir, message };
}
function complete(f, id = 'turn-1') { f.notify('turn/completed', { threadId: 'thread-a', turn: { id, status: 'completed' } }); }

test('concurrent clients share one initialized Codex process', async t => {
  const { agent, fixture } = setup(t);
  await Promise.all([agent.connect(), agent.connect(), agent.connect()]);
  assert.equal(fixture.processes.length, 1);
  assert.equal(fixture.count('initialize'), 1);
  assert.equal(fixture.count('initialized'), 1);
  assert.equal(agent.connection.authenticated, true);
  assert.equal(agent.connection.model, 'model-a');
});

test('tokens stream into one message; retransmission cannot start another paid turn', async t => {
  const { agent, fixture, message } = setup(t);
  await agent.send(message());
  const after = agent.version;
  fixture.notify('item/started', { threadId: 'thread-a', turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: '' } });
  fixture.notify('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn-1', itemId: 'a1', delta: '你好' });
  fixture.notify('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn-1', itemId: 'a1', delta: '，世界' });
  assert.equal(agent.session.items.at(-1).text, '你好，世界');
  assert.ok(agent.poll(after).events.some(e => e.item?.text === '你好'));
  complete(fixture);
  assert.equal(agent.session.status, 'idle');
  assert.equal((await agent.send(message())).duplicate, true);
  assert.equal(fixture.count('turn/start'), 1);
  assert.equal(agent.session.items.filter(i => i.type === 'user').length, 1);
});

test('concurrent submission and conversation switch are blocked while busy', async t => {
  const { agent, message } = setup(t);
  const first = agent.send(message());
  await assert.rejects(agent.send(message({ clientMessageId: 'message-0002' })), /当前回复/);
  assert.throws(() => agent.switchSession(), /先停止/);
  await first;
});

test('invalid model/effort is rejected before recording a submitted message', async t => {
  const { agent, fixture, message } = setup(t);
  await assert.rejects(agent.send(message({ model: 'missing' })), /模型不可用/);
  await assert.rejects(agent.send(message({ effort: 'ultra' })), /不支持/);
  assert.deepEqual(agent.session.receipts, {});
  assert.equal(agent.session.items.length, 0);
  assert.equal(fixture.count('turn/start'), 0);
  await agent.send(message({ effort: 'low' }));
  assert.equal(fixture.count('turn/start'), 1);
});

test('explicit start rejection can retry safely, while recorded receipts survive restart', async t => {
  const { agent, fixture, message, dataDir } = setup(t);
  fixture.rejectTurn = true;
  await assert.rejects(agent.send(message()), /model rejected/);
  assert.equal(agent.session.items[0].status, 'failed');
  assert.equal(Object.keys(agent.session.receipts).length, 0);
  fixture.rejectTurn = false;
  await agent.send(message()); complete(fixture); agent.close();
  const restored = new CodexAgent({ dataDir, spawn: fixture.spawn });
  t.after(() => { restored.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(restored.session.threadId, 'thread-a');
  assert.equal((await restored.send({ ...message(), sessionId: restored.session.id })).duplicate, true);
  await restored.send({ ...message(), sessionId: restored.session.id, clientMessageId: 'message-0002' });
  assert.equal(fixture.count('thread/resume'), 1);
  assert.equal(fixture.count('thread/start'), 1);
});

test('stop targets the active turn; late old output cannot revive it or replace a new turn', async t => {
  const { agent, fixture, message } = setup(t);
  await agent.send(message());
  await agent.interrupt();
  assert.equal(agent.session.status, 'interrupted');
  await agent.send(message({ clientMessageId: 'message-0002' }));
  fixture.notify('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn-1', itemId: 'stale', delta: 'late' });
  complete(fixture);
  assert.equal(agent.session.turnId, 'turn-2');
  assert.equal(agent.session.items.some(i => i.id === 'stale'), false);
});

test('process exit marks partial results interrupted and rejects pending RPC', async t => {
  const { agent, fixture, message } = setup(t);
  await agent.send(message());
  fixture.notify('item/started', { threadId: 'thread-a', turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: 'partial' } });
  fixture.processes[0].emit('exit', 1, null);
  assert.equal(agent.session.status, 'interrupted');
  assert.equal(agent.session.items.at(-1).status, 'interrupted');
  assert.equal(agent.session.turnId, null);
  assert.equal(agent.connection.status, 'offline');
  await assert.rejects(agent.rpc('anything'), /尚未连接/);
});

test('approval must match current session and runtime; permissions can be declined', async t => {
  const { agent, fixture, message } = setup(t);
  await agent.send(message());
  fixture.write(fixture.processes[0], { id: 800, method: 'item/permissions/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-1', permissions: { network: { enabled: true } } } });
  assert.equal(agent.session.status, 'waiting');
  assert.throws(() => agent.answer({ requestId: 800, decision: 'accept', sessionId: agent.session.id, epoch: 'old' }), /连接已更新/);
  assert.equal(agent.session.requests.length, 1);
  agent.answer({ requestId: 800, decision: 'decline', sessionId: agent.session.id, epoch: agent.epoch });
  assert.deepEqual(fixture.calls.find(c => c.id === 800).result, { permissions: {}, scope: 'turn' });
  assert.equal(agent.session.status, 'running');
  assert.throws(() => agent.answer({ requestId: 800, sessionId: agent.session.id, epoch: agent.epoch }), /已结束/);
});

test('foreign thread events are ignored; snapshots are independent and reset on epoch change', async t => {
  const { agent, fixture, message } = setup(t);
  await agent.send(message());
  const snapshot = agent.snapshot();
  fixture.notify('turn/completed', { threadId: 'foreign', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(agent.session.status, 'running');
  complete(fixture);
  assert.equal(snapshot.session.status, 'running');
  assert.equal(agent.poll(agent.version, 'previous-runtime').reset, true);
  agent.switchSession();
  assert.ok(agent.poll(snapshot.version).reset || agent.poll(snapshot.version).events.some(e => e.type === 'reset'));
});

test('HTTP enforces local origin and client marker; long poll delivers events and preview redirects', async t => {
  const { agent } = setup(t);
  const handler = createAgentHttp({ agent });
  const server = http.createServer(async (req, res) => {
    if (!await handler.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-PXDLS-Agent': '1' };
  assert.equal((await fetch(base + '/agent/session')).status, 403);
  assert.equal((await fetch(base + '/agent/session', { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(base + '/agent/connect', { method: 'POST', headers, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/agent/session', { headers: { ...headers, Origin: 'null' } })).status, 200);
  const redirect = await fetch(base + '/ui', { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/ui/');
  const html = await (await fetch(base + '/ui/')).text();
  assert.match(html, /agent-014.js/); assert.doesNotMatch(html, /<script src="ps-capture/);
  const poll = fetch(base + '/agent/events?after=' + agent.version + '&epoch=' + agent.epoch, { headers });
  agent.stateChanged();
  const result = await (await poll).json();
  assert.ok(result.events.length > 0);
  const reset = await (await fetch(base + '/agent/events?after=' + agent.version + '&epoch=old', { headers })).json();
  assert.equal(reset.reset, true);
});

 test('restored synthetic item ids reconcile with live messages without duplication', async t => {
  const { agent, fixture, message, dataDir } = setup(t);
  await agent.send(message());
  fixture.notify('item/completed', { threadId: 'thread-a', turnId: 'turn-1', item: { id: 'live-response', type: 'agentMessage', text: '记住了', phase: 'final_answer' } });
  complete(fixture); agent.close();
  fixture.resumeTurns = [{ id: 'turn-1', status: 'completed', items: [{ id: 'item-2', type: 'agentMessage', text: '记住了', phase: 'final_answer' }] }];
  const restored = new CodexAgent({ dataDir, spawn: fixture.spawn }); t.after(() => { restored.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await restored.send({ ...message(), sessionId: restored.session.id, clientMessageId: 'message-0002' });
  assert.equal(restored.session.items.filter(i => i.type === 'assistant').length, 1);
  assert.equal(restored.session.items.find(i => i.type === 'assistant').id, 'live-response');
});
