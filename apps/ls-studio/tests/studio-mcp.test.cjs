const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createPhotoshopMcp, listen } = require('../companion/photoshop-mcp.cjs');
const { tools, publicTools } = require('../companion/photoshop-tools');
const message = (name, args = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const response = value => new Response(JSON.stringify({ ok: true, value }));
test('MCP discovery includes25 shared Studio tools plus7 observation tools, never raw host mutation schemas', async () => {
  const mcp = createPhotoshopMcp();
  const result = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(tools.length, 7, 'bridge discovery stays observation-only');
  assert.equal(publicTools.length, 32); assert.equal(result.result.tools.length, 32);
  const names = result.result.tools.map(tool => tool.name);
  for (const name of ['studio_capabilities', 'studio_capture_context', 'studio_import_asset', 'studio_create_draft', 'studio_list_drafts', 'studio_get_draft', 'studio_update_draft', 'studio_run', 'studio_list_jobs', 'studio_get_job', 'studio_cancel', 'studio_apply_result', 'studio_rollback', 'studio_read_asset', 'studio_list_recipes', 'studio_get_recipe', 'studio_load_recipe']) assert.ok(names.includes(name));
  assert.ok(!names.includes('studio_edit_layer')); assert.ok(!names.includes('studio_capture'));
  const rollback = result.result.tools.find(tool => tool.name === 'studio_rollback');
  assert.deepEqual(rollback.inputSchema.required, ['jobId']); assert.equal(rollback.inputSchema.properties.receipt, undefined);
  result.result.tools[0].name = 'mutated';
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools[0].name, 'photoshop_capabilities');
});
test('MCP routes placement, rollback and legacy observations through the shared HTTP envelope exactly once', async () => {
  const requests = [];
  const mcp = createPhotoshopMcp({ base: 'http://127.0.0.1:17881', token: 'fixture-token', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:17881/studio/mcp'); assert.equal(init.headers['X-PXDLS-Tool'], 'fixture-token'); assert.equal(init.redirect, 'error');
    requests.push(JSON.parse(init.body)); return response({ status: 'fixture' });
  } });
  const placement = { jobId: 'job-a', resultId: 'result-a', requestId: 'request-a' };
  assert.equal((await mcp.handle(message('studio_apply_result', placement))).result.isError, false);
  await mcp.handle(message('studio_rollback', { jobId: 'job-a' }));
  await mcp.handle(message('photoshop_select_layers', { documentId: 1, layerIds: [2] }));
  assert.deepEqual(requests, [
    { operation: 'apply', arguments: placement }, { operation: 'rollback', arguments: { jobId: 'job-a' } },
    { operation: 'observe', arguments: { tool: 'photoshop_select_layers', arguments: { documentId: 1, layerIds: [2] } } },
  ]);
  const previous = requests.length;
  assert.equal((await mcp.handle(message('studio_rollback', { receipt: { arbitrary: true } }))).result.isError, true);
  assert.equal((await mcp.handle(message('studio_edit_layer', {}))).result.isError, true);
  assert.equal(requests.length, previous);
});
test('structured revision conflicts keep current shared state for the Agent instead of collapsing to a string', async () => {
  const current = { draftId: 'draft-a', revision: 3, params: { prompt: 'from professional UI' } };
  const mcp = createPhotoshopMcp({ token: 'fixture-token', fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { code: 'REVISION_CONFLICT', message: 'Draft has changed', details: { current } } }), { status: 409 }) });
  const result = (await mcp.handle(message('studio_update_draft', { draftId: 'draft-a', expectedRevision: 1, params: { prompt: 'old update' } }))).result;
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(result.structuredContent.error.details.current, current);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});
test('managed result pixels are image blocks, never duplicated into metadata text', async () => {
  const base64 = 'aW1hZ2U=';
  const mcp = createPhotoshopMcp({ token: 'fixture-token', fetchImpl: async () => response({ asset: { assetId: 'asset-managed', width: 2, height: 2 }, image: { base64, mimeType: 'image/png' } }) });
  const result = (await mcp.handle(message('studio_read_asset', { assetId: 'asset-managed' }))).result;
  assert.equal(result.isError, false); assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, base64); assert.equal(result.content[0].text.includes(base64), false);
  assert.equal(JSON.stringify(result.structuredContent).includes(base64), false);
});
test('invalid tokens/config, schemas and malformed responses fail locally without leaking secrets or retrying', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('fixture-private-token'); };
  for (const options of [{ token: '' }, { token: 'fixture-private-token', base: 'https://remote.example.test' }]) {
    const result = (await createPhotoshopMcp({ ...options, fetchImpl }).handle(message('studio_capabilities'))).result;
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('fixture-private-token'));
  }
  assert.equal(calls, 0);
  const disconnected = createPhotoshopMcp({ token: 'fixture-private-token', fetchImpl });
  const failed = (await disconnected.handle(message('studio_capabilities'))).result;
  assert.equal(calls, 1); assert.equal(failed.structuredContent.error.code, 'TRANSPORT_UNCERTAIN'); assert.ok(!JSON.stringify(failed).includes('fixture-private-token'));
  const malformed = createPhotoshopMcp({ token: 'fixture-token', fetchImpl: async () => new Response('fixture-private-token') });
  const invalid = (await malformed.handle(message('studio_capabilities'))).result;
  assert.equal(invalid.structuredContent.error.code, 'TRANSPORT_PROTOCOL_ERROR'); assert.ok(!JSON.stringify(invalid).includes('fixture-private-token'));
});
test('oversized declared responses are cancelled without reading or returning their data', async () => {
  let cancelled = false;
  const mcp = createPhotoshopMcp({ token: 'fixture-token', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(96 * 1024 * 1024 + 1) } }) });
  assert.equal((await mcp.handle(message('studio_capabilities'))).result.structuredContent.error.code, 'TRANSPORT_PROTOCOL_ERROR');
  assert.equal(cancelled, true);
});
test('stdio parser accepts chunked UTF8 requests and notifications without producing invalid IDs', async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', data => { text += data; }); listen(input, output);
  const first = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: '中文', method: 'ping' }) + '\n');
  input.write(first.subarray(0, 28)); input.write(first.subarray(28));
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write('{invalid}\n'); input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }));
  await new Promise(resolve => setImmediate(resolve));
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 3); assert.ok(messages.some(message => message.id === '中文' && message.result));
  assert.ok(messages.some(message => message.id === null && message.error.code === -32700));
  assert.ok(messages.some(message => message.id === 2 && message.result.serverInfo.name === 'ls-photoshop'));
});
