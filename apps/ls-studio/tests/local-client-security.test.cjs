'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { checkClient } = require('../companion/http/local-client');
const { createStudioHttp } = require('../companion/http/studio-http');
const { createAgentHttp } = require('../companion/agent-http');
const { PhotoshopBridge } = require('../companion/photoshop-bridge');

const PRIVATE = 'synthetic-private-conversation-and-image';
const ASSET = '11111111-2222-4333-8444-555555555555.png';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-local-client-'));
  const pluginDir = path.join(root, 'plugin'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(pluginDir); fs.mkdirSync(path.join(workspace, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'index.html'), '<html>synthetic-ui</html>');
  fs.writeFileSync(path.join(workspace, 'attachments', ASSET), PRIVATE);
  const calls = [], bridge = new PhotoshopBridge(), agent = new EventEmitter();
  for (const name of ['status', 'register', 'authorize', 'take', 'result', 'request']) {
    const original = bridge[name].bind(bridge);
    bridge[name] = (...args) => { calls.push('host.' + name); return original(...args); };
  }
  Object.assign(agent, { photoshop: bridge, workspace });
  for (const name of ['snapshot', 'listSessions', 'poll', 'connect', 'send', 'interrupt', 'answer', 'switchSession']) {
    agent[name] = () => { calls.push('agent.' + name); return name === 'poll' ? { reset: true, events: [{ text: PRIVATE }] } : { session: { items: [{ text: PRIVATE }] } }; };
  }
  const studio = createStudioHttp({ toolToken: bridge.toolToken, service: {
    discover() { calls.push('studio.discover'); return { synthetic: true }; },
    readAsset() { calls.push('studio.readAsset'); return { asset: { mimeType: 'image/png' }, data: Buffer.from(PRIVATE) }; },
  } });
  const legacy = createAgentHttp({ agent, pluginDir });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await studio.handle(req, res, url) || await legacy.handle(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  function request(route, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method, agent: false,
        headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers },
      }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Synthetic HTTP request timed out')));
      req.once('error', reject); req.end(payload);
    });
  }
  return { request, calls, bridge };
}
function denied(response, label) {
  assert.equal(response.status, 403, label);
  for (const header of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods']) assert.equal(response.headers[header], undefined, label + ': ' + header);
  assert.ok(!response.text.includes(PRIVATE) && !response.text.includes('hostToken'), label + ': no private data or executor credential');
}

test('opaque cross-site requests fail before every Agent, host, asset and Studio dispatch', async t => {
  const f = await fixture(t);
  const routes = [
    ['GET', '/ui'], ['GET', '/ui/'], ['GET', '/agent/assets/' + ASSET],
    ['GET', '/agent/session'], ['GET', '/agent/sessions'], ['GET', '/agent/events'],
    ...['connect', 'message', 'interrupt', 'answer', 'session/new', 'session/resume'].map(name => ['POST', '/agent/' + name, {}]),
    ['GET', '/photoshop/status'], ['POST', '/photoshop/call', { tool: 'photoshop_capabilities', arguments: {} }],
    ['POST', '/photoshop/register', { clientId: 'host-fixture' }], ['POST', '/photoshop/heartbeat', { clientId: 'host-fixture' }],
    ['POST', '/photoshop/result', {}], ['GET', '/photoshop/jobs?clientId=host-fixture'],
    ['POST', '/studio/call', { operation: 'discover', arguments: {} }],
    ['POST', '/studio/mcp', { operation: 'discover', arguments: {} }], ['GET', '/studio/assets/asset-fixture'],
  ];
  for (const [method, route, body] of routes) {
    const headers = { origin: 'null', 'sec-fetch-site': 'cross-site', 'x-pxdls-tool': f.bridge.toolToken };
    // Public UI and image routes have no marker, just like browser navigation/image requests.
    if (!route.startsWith('/ui') && !route.startsWith('/agent/assets/')) headers['x-pxdls-agent'] = '1';
    denied(await f.request(route, { method, body, headers }), method + ' ' + route);
  }
  denied(await f.request('/photoshop/register', { method: 'OPTIONS', headers: { origin: 'null', 'sec-fetch-site': 'cross-site', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-pxdls-agent' } }), 'registration preflight');
  assert.deepEqual(f.calls, []); assert.equal(f.bridge.host, null); assert.equal(f.bridge.jobs.size, 0);
});

test('foreign, opaque and missing origins cannot read sessions or attachments through source exceptions', async t => {
  const f = await fixture(t);
  for (const source of [
    { origin: 'https://untrusted.invalid' },
    { origin: 'file://', 'sec-fetch-site': 'cross-site' },
    { origin: 'uxp://ls-studio', 'sec-fetch-site': 'cross-site' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin: 'null', 'sec-fetch-site': 'none' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site', referer: 'https://untrusted.invalid/page' },
    { 'sec-fetch-site': 'cross-site', referer: 'http://127.0.0.1@untrusted.invalid/' },
  ]) {
    for (const route of ['/agent/session', '/agent/assets/' + ASSET, '/studio/assets/asset-fixture']) {
      denied(await f.request(route, { headers: { 'x-pxdls-agent': '1', ...source } }), route + ' ' + JSON.stringify(source));
    }
  }
  assert.deepEqual(f.calls, []);
});

test('local web pages and image requests retain access without acquiring native executor privileges', async t => {
  const f = await fixture(t);
  for (const source of [
    { origin: 'http://127.0.0.1:17881', 'sec-fetch-site': 'same-origin' },
    { origin: 'http://localhost:5174', 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost:5174' },
    { 'sec-fetch-site': 'same-origin' },
  ]) {
    const headers = { 'x-pxdls-agent': '1', ...source };
    const session = await f.request('/agent/session', { headers });
    assert.equal(session.status, 200); assert.ok(session.text.includes(PRIVATE));
    assert.equal(session.headers['access-control-allow-origin'], source.origin);
    const studio = await f.request('/studio/call', { method: 'POST', headers, body: { operation: 'discover', arguments: {} } });
    assert.equal(studio.status, 200);
    denied(await f.request('/photoshop/register', { method: 'POST', headers, body: { clientId: 'host-fixture' } }), 'browser registration');
    denied(await f.request('/photoshop/register', { method: 'OPTIONS', headers: { ...source, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-pxdls-agent' } }), 'browser registration preflight');
  }
  for (const headers of [
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'cross-site', referer: 'http://localhost:5174/ui/' },
  ]) {
    const image = await f.request('/agent/assets/' + ASSET, { headers });
    assert.equal(image.status, 200); assert.equal(image.text, PRIVATE);
    assert.equal((await f.request('/ui/', { headers })).status, 200);
  }
  assert.equal(f.bridge.host, null);
  assert.ok(f.calls.every(name => name === 'agent.snapshot' || name === 'studio.discover'));
});

test('native UXP and loopback CLI keep registration, session and preflight access without browser metadata', async t => {
  const f = await fixture(t);
  for (const source of [{ origin: 'null' }, { origin: 'file://' }, { origin: 'uxp://ls-studio' }, {}]) {
    const pre = await f.request('/photoshop/register', { method: 'OPTIONS', headers: { ...source, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, X-PXDLS-Agent, X-PXDLS-Host' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], source.origin);
    assert.equal(pre.headers['access-control-allow-credentials'], undefined);
    const headers = { 'x-pxdls-agent': '1', ...source };
    const registration = await f.request('/photoshop/register', { method: 'POST', headers, body: { clientId: 'native-fixture' } });
    assert.equal(registration.status, 200); assert.ok(JSON.parse(registration.text).hostToken);
    assert.equal((await f.request('/agent/session', { headers })).status, 200);
    assert.equal((await f.request('/studio/call', { method: 'POST', headers, body: { operation: 'discover', arguments: {} } })).status, 200);
  }
  assert.equal((await f.request('/agent/session', { headers: { origin: 'null' } })).status, 403, 'source validation does not replace the client marker');
  assert.equal((await f.request('/photoshop/call', { method: 'POST', headers: { 'x-pxdls-agent': '1' }, body: { tool: 'photoshop_capabilities', arguments: {} } })).status, 403, 'source validation does not replace the tool token');
});

test('Agent and Studio preflight reject unsupported methods and headers before business access', async t => {
  const f = await fixture(t);
  for (const route of ['/agent/session', '/photoshop/register', '/studio/call']) {
    for (const requested of [
      { 'access-control-request-method': 'DELETE' },
      { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-untrusted' },
      {},
    ]) denied(await f.request(route, { method: 'OPTIONS', headers: { origin: 'null', ...requested } }), route + ' invalid preflight');
  }
  assert.deepEqual(f.calls, []);
});

test('shared guard requires a real loopback peer and unambiguous local Host', () => {
  const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: 'localhost:17881', ...headers }, socket: { remoteAddress } });
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    for (const host of ['127.0.0.1:17881', 'localhost:5174', '[::1]:17881']) assert.deepEqual(checkClient(request({ host }, remoteAddress)), { native: true });
  }
  const rejected = req => assert.throws(() => checkClient(req), error => error.status === 403 && error.code === 'LOCAL_CLIENT_REQUIRED');
  for (const host of [undefined, '', [], ['localhost'], 'untrusted.invalid', 'localhost@untrusted.invalid', 'untrusted.invalid@localhost', 'localhost/path', 'localhost?x', 'localhost#x', 'localhost\\x', 'localhost:17881 extra']) rejected(request({ host }));
  for (const remoteAddress of [null, '', '192.0.2.1', '::ffff:192.0.2.1']) rejected(request({ 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' }, remoteAddress));
  rejected({ headers: { host: 'localhost' } });
});

test('shared guard rejects malformed origins and browser metadata without reflecting their contents', () => {
  for (const source of [
    ...['https://untrusted.invalid', 'http://localhost@untrusted.invalid', 'http://untrusted.invalid@localhost', 'http://localhost/private', 'http://localhost/?x', 'http://localhost/#x', 'uxp://ls-studio/private', 'uxp://ls-studio?x', '', ['null']].map(origin => ({ origin })),
    { 'sec-fetch-site': 'invalid' }, { 'sec-fetch-site': ['cross-site'] },
    ...['null', 'file://', 'uxp://ls-studio'].flatMap(origin => ['same-origin', 'same-site', 'cross-site', 'none'].map(site => ({ origin, 'sec-fetch-site': site }))),
  ]) {
    assert.throws(() => checkClient({ headers: { host: 'localhost', ...source }, socket: { remoteAddress: '127.0.0.1' } }), error => error.status === 403 && error.code === 'ORIGIN_REJECTED' && !error.message.includes('untrusted.invalid'));
  }
});
