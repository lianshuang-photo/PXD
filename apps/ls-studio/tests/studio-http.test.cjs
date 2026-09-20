const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createStudioHttp, MAX_BODY_BYTES, MAX_ARGUMENT_BYTES } = require('../companion/http/studio-http');
const { createPhotoshopMcp } = require('../companion/photoshop-mcp.cjs');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createCapabilityService } = require('../companion/capabilities/service');
const { context } = require('../companion/domain/fixtures');
const { DomainError, clone } = require('../companion/domain/contracts');
const encode = require('../plugin/ps-encode-014');
const PNG = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(91), 3));
const TOKEN = 'fixture-local-tool-token';
async function serverFor(t, service, token = TOKEN) {
  const transport = createStudioHttp({ service, toolToken: token });
  const server = http.createServer(async (req, res) => { if (!await transport.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, operation, args = {}, extra = {}) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pxdls-agent': '1', ...extra }, body: JSON.stringify({ operation, arguments: args }) });
    return { status: response.status, body: await response.json() };
  }
  return { base, server, request, ui: (operation, args, headers) => request('/studio/call', operation, args, headers), agent: (operation, args, headers) => request('/studio/mcp', operation, args, { 'x-pxdls-tool': TOKEN, ...headers }) };
}
async function realService(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxd-studio-http-')), calls = [];
  const assets = createAssetStore({ rootDir: path.join(rootDir, 'assets') }), jobs = createJobStore({ rootDir: path.join(rootDir, 'jobs') });
  const bridge = { status: () => ({ connected: true }), request: async (name, args) => {
    calls.push({ name, args: clone(args) });
    if (name === 'studio_capture') return { ok: true, documentRef: clone(context.documentRef), scope: args.scope, transform: clone(context.transform), image: { base64: PNG.toString('base64'), mimeType: 'image/png', width: 2, height: 2 }, ...(args.scope === 'selection' ? { mask: { base64: PNG.toString('base64'), mimeType: 'image/png', width: 2, height: 2 } } : {}) };
    if (name === 'photoshop_get_document') return { ok: true, open: true, documentId: 1 };
    if (name === 'photoshop_render_preview') return { ok: true, width: 2, image: { base64: PNG.toString('base64'), mimeType: 'image/png' } };
    if (name === 'studio_rollback') return { ok: true, receipt: { ...args.receipt, rollbackStatus: 'rolled-back' } };
    return { ok: true, receipt: { jobId: args.jobId, mutationId: args.mutationId, documentRef: args.documentRef, createdLayerIds: [2], modifiedLayers: [], rollbackStatus: 'available' } };
  } };
  const provider = { describe: () => ({ id: 'fixture', model: 'fixture-model', configured: true, mask: 'advisory', limits: { inputImages: 3, inputBytes: 14 * 1024 * 1024 } }), generate: async input => { calls.push({ name: 'generate', args: input }); return { images: [{ data: PNG, mimeType: 'image/png' }], provider: { id: 'fixture', model: 'fixture-model' } }; } };
  const service = createCapabilityService({ assets, jobs, provider, bridge });
  t.after(async () => { await service.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  return { service, assets, jobs, calls };
}
test('professional HTTP and MCP share revisions, immutable jobs, result pixels and idempotent placement', async t => {
  const { service, calls } = await realService(t), http = await serverFor(t, service);
  const mcp = createPhotoshopMcp({ base: http.base, token: TOKEN }); let sequence = 0;
  const tool = async (name, args = {}) => (await mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } })).result;
  const discover = await http.ui('discover'); assert.equal(discover.body.value.provider.limits.inputImages, 3);
  const captured = (await http.ui('capture', { documentId: 1, scope: 'selection' })).body.value;
  const draft = (await http.ui('createDraft', { capabilityId: 'image.edit', params: { prompt: 'initial' }, context: captured, source: 'system' })).body.value;
  assert.equal(draft.source, 'ui');
  const edited = await tool('studio_update_draft', { draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'agent edit' }, source: 'ui' });
  assert.equal(edited.structuredContent.revision, 2); assert.equal(edited.structuredContent.source, 'agent');
  assert.equal((await http.ui('getDraft', { draftId: draft.draftId })).body.value.params.prompt, 'agent edit');
  const stale = await tool('studio_update_draft', { draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'stale' } });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'REVISION_CONFLICT'); assert.equal(stale.structuredContent.error.details.current.revision, 2);
  const input = { draftId: draft.draftId, expectedRevision: 2, requestId: 'one-shared-run' };
  const submitted = (await tool('studio_run', input)).structuredContent;
  assert.equal(submitted.job.source, 'agent');
  assert.equal((await http.ui('run', input)).body.value.duplicate, true);
  await service.waitForIdle();
  const job = (await http.ui('getJob', { jobId: submitted.job.jobId })).body.value;
  assert.equal(job.status, 'succeeded'); assert.equal(calls.filter(call => call.name === 'generate').length, 1);
  const inspected = await tool('studio_read_asset', { assetId: job.results[0].assetId });
  assert.equal(inspected.content[1].type, 'image'); assert.equal(inspected.content[1].data, PNG.toString('base64'));
  assert.ok(!inspected.content[0].text.includes(PNG.toString('base64')));
  const raw = await fetch(http.base + '/studio/assets/' + job.results[0].assetId, { headers: { 'x-pxdls-agent': '1' } });
  assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), PNG);
  await http.ui('updateDraft', { draftId: draft.draftId, expectedRevision: 2, params: { prompt: 'Later current draft' } });
  const revision = (await http.ui('deriveDraft', { jobId: job.jobId, mode: 'original', source: 'system' })).body.value;
  assert.equal(revision.source, 'ui'); assert.notEqual(revision.draftId, draft.draftId); assert.equal(revision.params.prompt, 'agent edit');
  const candidateDraft = (await tool('studio_derive_draft', { jobId: job.jobId, mode: 'candidate-reference', resultId: job.results[0].resultId, source: 'ui' })).structuredContent;
  assert.equal(candidateDraft.source, 'agent'); assert.deepEqual(candidateDraft.context.refs, [{ assetId: job.results[0].assetId, role: 'reference' }]);
  assert.equal(candidateDraft.params.model, 'fixture-model'); assert.equal(revision.params.model, 'fixture-model');
  assert.equal(candidateDraft.context.baseAssetId, captured.baseAssetId); assert.equal(calls.filter(call => call.name === 'generate').length, 1);
  assert.deepEqual((await http.ui('getJob', { jobId: job.jobId })).body.value, job);
  const placement = { jobId: job.jobId, resultId: job.results[0].resultId, requestId: 'place-once' };
  assert.equal((await tool('studio_apply_result', placement)).structuredContent.placement.status, 'applied');
  assert.equal((await http.ui('apply', placement)).body.value.placement.status, 'applied');
  assert.equal(calls.filter(call => call.name === 'studio_apply_result').length, 1);
  assert.equal((await tool('studio_rollback', { jobId: job.jobId })).structuredContent.placement.status, 'rolled-back');
});
test('only observed bounded legacy tools are forwarded; internal host operations remain unavailable', async t => {
  const { service, calls } = await realService(t), f = await serverFor(t, service);
  assert.equal((await f.ui('observe', { tool: 'photoshop_get_document', arguments: {} })).body.value.documentId, 1);
  for (const [operation, args] of [
    ['studio_edit_layer', {}], ['studio_apply_result', {}],
    ['observe', { tool: 'studio_apply_result', arguments: {} }],
    ['observe', { tool: 'photoshop_select_layers', arguments: { documentId: 1, layerIds: [1, 1] } }],
    ['observe', { tool: 'photoshop_list_layers', arguments: { documentId: 1, limit: 201 } }],
    ['createDraft', { capabilityId: 'image.edit', params: { script: 'arbitrary' } }],
  ]) assert.equal((await f.ui(operation, args)).body.ok, false);
  assert.deepEqual(calls.map(call => call.name), ['photoshop_get_document']);
});
test('local host/origin, client marker and MCP token checks happen before service access', async t => {
  let calls = 0;
  const f = await serverFor(t, { discover() { calls++; return {}; } });
  for (const headers of [
    { origin: 'https://evil.example.test' },
    { 'x-pxdls-agent': '' }, { origin: 'null', 'sec-fetch-site': 'cross-site' },
    { origin: 'http://127.0.0.1@evil.example.test' },
  ]) assert.equal((await f.ui('discover', {}, headers)).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/studio/call', { method: 'POST', headers: { host: 'evil.example.test', 'content-type': 'application/json', 'x-pxdls-agent': '1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify({ operation: 'discover', arguments: {} }));
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request('/studio/mcp', 'discover')).status, 403);
  assert.equal((await f.agent('discover', {}, { 'x-pxdls-tool': 'wrong-token' })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await f.ui('discover', {}, { origin: 'null' })).status, 200);
  assert.equal((await f.ui('discover', {}, { origin: 'uxp://ls-studio' })).status, 200);
  assert.equal((await f.ui('discover', {}, { origin: 'http://localhost:5174' })).status, 200);
  assert.equal((await f.agent('discover')).status, 200);
  const missing = await serverFor(t, { discover() { calls++; return {}; } }, null);
  // Factory without a configured token cannot accidentally authorize an absent one.
  const unconfigured = createStudioHttp({ service: {} }); assert.equal(typeof unconfigured.handle, 'function');
  assert.equal((await missing.request('/studio/mcp', 'discover')).status, 403);
});
test('CORS preflight is restricted and never needs or discloses a tool token', async t => {
  const f = await serverFor(t, {});
  const good = await fetch(f.base + '/studio/mcp', { method: 'OPTIONS', headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, X-PXDLS-Agent, X-PXDLS-Tool' } });
  assert.equal(good.status, 204); assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5174');
  assert.equal(good.headers.get('access-control-allow-credentials'), null);
  const bad = await fetch(f.base + '/studio/call', { method: 'OPTIONS', headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'DELETE' } });
  assert.equal(bad.status, 403);
});
test('asset URLs cannot traverse paths or bypass the required client marker', async t => {
  const reads = [];
  const f = await serverFor(t, { readAsset(id) { reads.push(id); throw new DomainError('ASSET_NOT_FOUND', 'missing', 404); } });
  for (const route of ['/studio/assets/../state.json', '/studio/assets/%2e%2e%2fstate.json', '/studio/assets/asset-id%2fimage', '/studio/assets/asset-id/extra']) {
    assert.equal((await fetch(f.base + route, { headers: { 'x-pxdls-agent': '1' } })).status, 404);
  }
  assert.equal((await fetch(f.base + '/studio/assets/asset-safe')).status, 403);
  assert.deepEqual(reads, []);
  assert.equal((await fetch(f.base + '/studio/assets/asset-safe', { headers: { 'x-pxdls-agent': '1' } })).status, 404);
  assert.deepEqual(reads, ['asset-safe']);
});
test('malformed and oversized request bodies are rejected without execution', async t => {
  let calls = 0; const f = await serverFor(t, { discover() { calls++; return {}; } });
  const send = (body, headers = {}) => fetch(f.base + '/studio/call', { method: 'POST', headers: { 'x-pxdls-agent': '1', 'content-type': 'application/json', ...headers }, body });
  assert.equal((await send('{broken')).status, 400);
  assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('{}', { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await send(JSON.stringify({ operation: 'discover', arguments: {}, unexpected: true }))).status, 400);
  assert.equal((await send(JSON.stringify({ operation: 'discover', arguments: { oversized: 'x'.repeat(MAX_ARGUMENT_BYTES) } }))).status, 413);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/studio/call', { method: 'POST', agent: false, headers: { 'x-pxdls-agent': '1', 'content-type': 'application/json', 'content-length': MAX_BODY_BYTES + 1 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 413); assert.equal(calls, 0);
});
test('interrupted bodies do not submit jobs or destabilize the local HTTP server', async t => {
  let calls = 0; const f = await serverFor(t, { discover() { calls++; return {}; } });
  const req = http.request(f.base + '/studio/call', { method: 'POST', headers: { 'x-pxdls-agent': '1', 'content-type': 'application/json', 'content-length': 100 } });
  req.on('error', () => {}); req.write('{'); await new Promise(resolve => setTimeout(resolve, 10)); req.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.ui('discover')).status, 200); assert.equal(calls, 1);
});
test('recipe adapters use one service and retain Unicode parameter IDs and revisions', async t => {
  const calls = [];
  const f = await serverFor(t, {
    listRecipes: args => { calls.push(['list', args]); return { recipes: [] }; },
    getRecipe: recipeId => { calls.push(['get', recipeId]); return { recipeId }; },
    loadRecipe: args => { calls.push(['load', args]); return { revision: args.expectedRevision + 1, source: args.source }; },
  });
  assert.equal((await f.ui('getRecipe', { recipeId: 'f_001' })).body.value.recipeId, 'f_001');
  assert.equal((await f.agent('loadRecipe', { recipeId: 'f_001', draftId: 'draft-a', expectedRevision: 2, values: { '皮肤质感': 0.5 }, refs: [{ assetId: 'asset-ref', role: 'identity' }], source: 'ui' })).body.value.source, 'agent');
  assert.deepEqual(calls[0], ['get', 'f_001']); assert.equal(calls[1][1].values['皮肤质感'], 0.5);
  assert.equal((await f.ui('loadRecipe', { recipeId: 'f_001', draftId: 'draft-a', expectedRevision: 2, values: { '强度': 2 } })).status, 400);
  assert.equal((await f.ui('listRecipes', { limit: 201 })).status, 400);
});
