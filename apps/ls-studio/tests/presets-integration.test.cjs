'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createRecipeCatalog } = require('../companion/capabilities/recipes');
const { createRecipeLibrary } = require('../companion/presets');
const { createCapabilityService } = require('../companion/capabilities/service');
const { createStudioHttp } = require('../companion/http/studio-http');
const { createPhotoshopMcp } = require('../companion/photoshop-mcp.cjs');
const { createTransport, createController: createStudio } = require('../plugin/studio-014');
const { createController: createPresets } = require('../plugin/presets-014');
const { context } = require('../companion/domain/fixtures');
const { encodePNGFromRGB } = require('../plugin/ps-encode-014');
const copy = value => JSON.parse(JSON.stringify(value));
const definition = { title: 'Identity touchup', category: 'head', content: '{"instruction":"Keep identity","@param:细节":0.5}', refImages: [{ slotId: 'identity', label: '人物参考', role: 'identity' }] };
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-presets-integration-')), calls = [];
  const assets = createAssetStore({ rootDir: path.join(root, 'assets') }), jobs = createJobStore({ rootDir: path.join(root, 'jobs') });
  const factoryCatalog = createRecipeCatalog(), recipes = createRecipeLibrary({ rootDir: path.join(root, 'presets'), factoryCatalog });
  const png = Buffer.from(encodePNGFromRGB(2, 2, new Uint8Array(12).fill(91), 3));
  const service = createCapabilityService({ assets, jobs, recipes,
    provider: { describe: () => ({ configured: true }), generate: async input => { calls.push({ name: 'generate', input }); return { images: [{ data: png, mimeType: 'image/png' }], provider: { id: 'fixture' } }; } },
    bridge: { status: () => ({ connected: true }), request: async (name, args) => { if (name === 'photoshop_get_document') return { ok: true, open: true, document: { id: 1 } }; calls.push({ name }); assert.equal(name, 'studio_capture'); return { ok: true, scope: args.scope, documentRef: copy(context.documentRef), transform: copy(context.transform), image: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 }, mask: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 } }; } }
  });
  const adapter = createStudioHttp({ service, toolToken: 'preset-test-token' });
  const server = http.createServer(async (req, res) => { if (!await adapter.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, transport = createTransport({ base }), mcp = createPhotoshopMcp({ base, token: 'preset-test-token' }); let sequence = 0;
  const tool = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } })).result;
  const studio = createStudio({ transport }), presets = createPresets({ transport, onUse: recipeId => studio.selectRecipe(recipeId) });
  t.after(() => { studio.dispose(); presets.dispose(); });
  await studio.refresh();
  return { service, recipes, assets, jobs, calls, transport, tool, studio, presets, png };
}
test('UI creates, MCP edits, stale UI preserves edits; export/import and immutable history use one library', async t => {
  const f = await setup(t);
  f.presets.edit(definition); const first = await f.presets.save(); assert.equal(first.source, 'ui');
  const read = await f.tool('studio_get_recipe', { recipeId: first.recipeId }); assert.equal(read.structuredContent.title, definition.title);
  f.presets.edit({ title: 'Unsaved UI title' });
  const agent = await f.tool('studio_update_recipe', { recipeId: first.recipeId, expectedRevision: 1, definition: { ...definition, title: 'Agent title' }, source: 'system' });
  assert.equal(agent.isError, false); assert.equal(agent.structuredContent.source, 'agent');
  await assert.rejects(f.presets.save(), { code: 'RECIPE_REVISION_CONFLICT' });
  assert.equal(f.presets.snapshot().form.title, 'Unsaved UI title');
  await f.presets.select(first.recipeId, true); assert.equal(f.presets.snapshot().form.title, 'Agent title');
  const text = await f.presets.exportText(); assert.equal(JSON.parse(text).definition.title, 'Agent title');
  const imported = await f.tool('studio_import_recipe', { bundle: JSON.parse(text), requestId: 'agent-import', source: 'ui' });
  assert.equal(imported.isError, false); assert.notEqual(imported.structuredContent.recipeId, first.recipeId); assert.equal(imported.structuredContent.source, 'agent');
  const old = await f.tool('studio_get_recipe', { recipeId: first.recipeId, revision: 1 }); assert.equal(old.structuredContent.title, definition.title);
  const restored = await f.tool('studio_restore_recipe', { recipeId: first.recipeId, expectedRevision: 2, targetRevision: 1 }); assert.equal(restored.structuredContent.revision, 3);
  await f.presets.select(first.recipeId, true); await f.presets.archive();
  assert.equal((await f.transport.call('listRecipes', { kind: 'user' })).items.some(item => item.recipeId === first.recipeId), false);
  await f.presets.restore(); assert.equal(f.presets.snapshot().selected.revision, 5);
  const copied = await f.tool('studio_copy_recipe', { recipeId: 'f_013', expectedSourceHash: f.recipes.get('f_013').sourceHash, requestId: 'copy-factory' }); assert.equal(copied.structuredContent.kind, 'user');
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.listJobs().length, 0);
});
test('explicit reference mapping loads the selected hash and job snapshots survive later preset updates', async t => {
  const f = await setup(t); await f.studio.createDraft('image.edit'); await f.studio.capture('selection');
  await f.studio.importReference({ base64: f.png.toString('base64'), mimeType: 'image/png' }, 'reference');
  f.presets.edit(definition); const first = await f.presets.save(); await f.presets.use();
  await assert.rejects(f.studio.loadSelectedRecipe(), { code: 'REFERENCE_MAPPING_REQUIRED' });
  const ref = f.studio.snapshot().form.context.refs[0]; f.studio.setRecipeReference(0, ref.assetId); f.studio.setRecipeValue('细节', 0.75);
  const loaded = await f.studio.loadSelectedRecipe();
  assert.equal(loaded.params.recipe.sourceHash, first.sourceHash); assert.equal(JSON.parse(loaded.params.prompt)['@param:细节'], 0.75);
  assert.deepEqual(loaded.context.refs, [{ assetId: ref.assetId, role: 'identity' }]); assert.equal(f.jobs.listJobs().length, 0);
  assert.deepEqual(f.calls.map(call => call.name), ['studio_capture']);
  const job = await f.studio.run(); await f.service.waitForIdle();
  const snapshot = f.jobs.getJob(job.jobId).snapshot;
  const edited = await f.tool('studio_update_recipe', { recipeId: first.recipeId, expectedRevision: 1, definition: { ...definition, content: '{"instruction":"New version"}' } }); assert.equal(edited.isError, false);
  assert.deepEqual(f.jobs.getJob(job.jobId).snapshot, snapshot); assert.equal(snapshot.params.recipe.sourceHash, first.sourceHash);
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 1);
  assert.deepEqual(f.calls.find(call => call.name === 'generate').input.context.refs, loaded.context.refs);
  const stale = await f.tool('studio_load_recipe', { recipeId: first.recipeId, expectedSourceHash: first.sourceHash, draftId: loaded.draftId, expectedRevision: loaded.revision, refs: loaded.context.refs });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'RECIPE_REVISION_CONFLICT');
});
test('transport validates new operations and cannot smuggle paths or forge modification source', async t => {
  const f = await setup(t);
  const bad = await f.tool('studio_import_recipe', { bundle: { schemaVersion: 1, format: 'ls-studio-preset', definition: { ...definition, refImages: [{ path: '/tmp/image.png', role: 'identity' }] } }, requestId: 'bad' });
  assert.equal(bad.isError, true); assert.equal(f.recipes.list({ kind: 'user' }).total, 0);
  const user = await f.transport.call('createRecipe', { definition, requestId: 'ui-stamped', source: 'agent' }); assert.equal(user.source, 'ui');
  const forbidden = await f.tool('studio_update_recipe', { recipeId: 'f_013', expectedRevision: 1, definition }); assert.equal(forbidden.isError, true); assert.equal(forbidden.structuredContent.error.code, 'RECIPE_READ_ONLY');
});
