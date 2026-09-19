'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecipeCatalog } = require('../companion/capabilities/recipes');
const { createCapabilityService } = require('../companion/capabilities/service');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { context } = require('../companion/domain/fixtures');
const { clone } = require('../companion/domain/contracts');
const { encodePNGFromRGB } = require('../plugin/ps-encode-014');
const png = Buffer.from(encodePNGFromRGB(2, 2, new Uint8Array(12).fill(127), 3));

async function setup(t, preset) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-recipe-service-'));
  let recipes;
  if (preset) {
    const rootDir = path.join(root, 'recipes'); fs.mkdirSync(rootDir);
    fs.writeFileSync(path.join(rootDir, 'recipe.json'), JSON.stringify(preset));
    recipes = createRecipeCatalog({ rootDir });
  } else recipes = createRecipeCatalog();
  const assets = createAssetStore({ rootDir: path.join(root, 'assets') });
  const jobsRoot = path.join(root, 'jobs'), jobs = createJobStore({ rootDir: jobsRoot });
  const generated = [], hostCalls = [];
  const provider = { describe: () => ({ id: 'fixture', configured: true }), generate: async input => {
    generated.push(input);
    return { images: [{ data: png, mimeType: 'image/png' }], provider: { id: 'fixture', model: 'fixture-image' } };
  } };
  const bridge = { status: () => ({ connected: true }), request: async (name, args) => {
    hostCalls.push(name); assert.equal(name, 'studio_capture');
    return { ok: true, documentRef: clone(context.documentRef), scope: args.scope, transform: clone(context.transform), image: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 }, mask: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 } };
  } };
  const service = createCapabilityService({ assets, jobs, bridge, provider, recipes });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const capture = await service.capture({ documentId: 1, scope: 'selection' });
  const imported = await service.importAsset({ base64: png.toString('base64'), mimeType: 'image/png' });
  capture.refs = [{ assetId: imported.assetId, role: 'identity' }];
  capture.preserve = ['Keep the existing expression'];
  const draft = await service.createDraft({ capabilityId: 'image.edit', params: {}, context: capture, source: 'ui' });
  return { service, recipes, capture, draft, generated, hostCalls, jobsRoot };
}

test('recipe values and references survive shared draft, immutable execution, provider input and restart', async t => {
  const f = await setup(t), userText = '保留眼镜。\n不要改变身份。';
  const loaded = await f.service.loadRecipe({ draftId: f.draft.draftId, expectedRevision: 1, recipeId: 'f_013', values: { 下颌线锐化: 0.25 }, userText, source: 'agent' });
  assert.equal(loaded.revision, 2); assert.equal(loaded.source, 'agent');
  assert.deepEqual(loaded.context, f.capture);
  assert.equal(loaded.params.recipe.values.下颌线锐化, 0.25);
  assert.equal(loaded.params.recipe.values.磨皮强度, 0.65);
  assert.equal(loaded.params.recipe.sourceHash, f.recipes.get('f_013').sourceHash);
  assert.ok(loaded.params.prompt.endsWith('\n\n' + userText));
  assert.equal(f.generated.length, 0); assert.deepEqual(f.hostCalls, ['studio_capture']);
  const { job } = await f.service.run({ draftId: loaded.draftId, expectedRevision: loaded.revision, requestId: 'recipe-run-once', source: 'agent' });
  await f.service.updateDraft({ draftId: loaded.draftId, expectedRevision: loaded.revision, params: { prompt: 'Next edit only' }, source: 'ui' });
  await f.service.waitForIdle();
  const finished = await f.service.getJob(job.jobId);
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.placement.status, 'not-requested');
  assert.equal(f.generated.length, 1);
  assert.deepEqual(finished.snapshot.params, loaded.params);
  assert.deepEqual(finished.snapshot.context, loaded.context);
  assert.deepEqual(f.generated[0].params, loaded.params);
  assert.deepEqual(f.generated[0].context.refs, f.capture.refs);
  assert.equal(f.generated[0].inputs.refs[0].asset.assetId, f.capture.refs[0].assetId);
  assert.equal(f.generated[0].inputs.refs[0].role, 'identity');
  await f.service.close();
  const restarted = createJobStore({ rootDir: f.jobsRoot });
  assert.deepEqual((await restarted.getJob(job.jobId)).snapshot, finished.snapshot);
});

test('loading respects revisions and explicit empty refs clears the draft without submitting work', async t => {
  const f = await setup(t);
  await f.service.updateDraft({ draftId: f.draft.draftId, expectedRevision: 1, params: { prompt: 'UI edit' }, source: 'ui' });
  await assert.rejects(f.service.loadRecipe({ draftId: f.draft.draftId, expectedRevision: 1, recipeId: 'f_000', source: 'agent' }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.service.getDraft(f.draft.draftId)).params.prompt, 'UI edit');
  const cleared = await f.service.loadRecipe({ draftId: f.draft.draftId, expectedRevision: 2, recipeId: 'f_000', refs: [], source: 'agent' });
  assert.deepEqual(cleared.context.refs, []);
  assert.equal(cleared.context.baseAssetId, f.capture.baseAssetId);
  assert.equal(cleared.context.selectionMaskAssetId, f.capture.selectionMaskAssetId);
  assert.deepEqual(cleared.context.preserve, f.capture.preserve);
  assert.equal(f.generated.length, 0); assert.deepEqual(f.hostCalls, ['studio_capture']);
});

test('preset reference slots cannot silently inherit a previous draft mapping', async t => {
  const f = await setup(t, { id: 'ref-recipe', title: 'Reference recipe', category: 'head', subCategory: '', content: '{"instruction":"Use mapped identity"}', refImages: ['https://example.invalid/reference.png'], _isFactory: true });
  const args = { draftId: f.draft.draftId, expectedRevision: 1, recipeId: 'ref-recipe', source: 'agent' };
  await assert.rejects(f.service.loadRecipe(args), { code: 'REFERENCE_REQUIRED' });
  assert.equal((await f.service.getDraft(f.draft.draftId)).revision, 1);
  const loaded = await f.service.loadRecipe({ ...args, refs: f.capture.refs });
  assert.deepEqual(loaded.context.refs, f.capture.refs);
  assert.equal(f.generated.length, 0);
});
