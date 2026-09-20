const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createCapabilityService } = require('../companion/capabilities/service');
const { context: fixtureContext } = require('../companion/domain/fixtures');
const { DomainError } = require('../companion/domain/contracts');
const encode = require('../plugin/ps-encode-014');
const png = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(127), 3));
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-result-drafts-'));
  const assets = createAssetStore({ rootDir: path.join(root, 'assets') }), jobs = createJobStore({ rootDir: path.join(root, 'jobs') });
  const f = { limits: { inputImages: 14, inputBytes: 14 * 1024 * 1024 }, model: 'fixture-model', calls: [] };
  const service = createCapabilityService({ assets, jobs, provider: { describe: input => f.describe ? f.describe(input) : ({ model: f.model, limits: f.limits }), generate() { f.calls.push('generate'); throw Error('No provider execution authorized by draft creation'); } }, bridge: { status: () => ({ connected: false }), request() { f.calls.push('host'); throw Error('No PS operation authorized by draft creation'); } } });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = structuredClone(fixtureContext), source = { documentRef: context.documentRef, scope: context.scope, transform: context.transform };
  async function asset(purpose, source) { return assets.put({ data: png, mimeType: 'image/png', purpose, source }); }
  context.baseAssetId = (await asset('input', source)).assetId;
  context.selectionMaskAssetId = (await asset('mask', source)).assetId;
  context.refs = [{ assetId: (await asset('reference', { kind: 'user-import' })).assetId, role: 'identity' }];
  context.settings = { autoApply: true, groupResults: false, returnType: 'new-layer' };
  context.preserve = ['costume'];
  const params = { prompt: 'original compiled prompt', recipe: { recipeId: 'recipe-original', sourceHash: 'a'.repeat(64), values: { strength: 0.6 } }, model: f.model, imageSize: '1K', ...options.params };
  if (options.noExplicitModel) delete params.model;
  const draft = jobs.createDraft({ capabilityId: 'image.edit', context, params });
  const { job } = jobs.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'request-original' });
  jobs.transition(job.jobId, 'running');
  const candidate = await asset('result', { jobId: job.jobId });
  jobs.addResults(job.jobId, [{ resultId: 'candidate-1', assetId: candidate.assetId }]); jobs.transition(job.jobId, 'succeeded', options.recordedModel === undefined ? {} : { provider: { id: 'fixture', model: options.recordedModel } });
  Object.assign(f, { service, jobs, assets, draft, job: jobs.getJob(job.jobId), candidate, context, params }); return f;
}
test('derivation uses immutable job inputs despite current draft edits, preserving recipe and settings without execution', async t => {
  const f = await fixture(t), originalJob = structuredClone(f.job);
  f.jobs.updateDraft({ draftId: f.draft.draftId, expectedRevision: 1, params: { prompt: 'changed current draft' }, context: null, source: 'agent' });
  const first = await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original' });
  const second = await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original', source: 'agent' });
  assert.notEqual(first.draftId, f.draft.draftId); assert.notEqual(first.draftId, second.draftId); assert.equal(first.revision, 1);
  assert.deepEqual(first.params, f.job.snapshot.params); assert.deepEqual(first.context, f.job.snapshot.context); assert.equal(second.source, 'agent');
  assert.deepEqual(f.jobs.getJob(f.job.jobId), originalJob); assert.equal(f.jobs.listJobs().length, 1); assert.deepEqual(f.calls, []);
  first.params.recipe.values.strength = 0;
  assert.equal(f.jobs.getDraft(second.draftId).params.recipe.values.strength, 0.6);
});
test('candidate revision appends a reference while preserving exact original source, mask, references and compiled recipe', async t => {
  const f = await fixture(t), draft = await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' });
  assert.deepEqual(draft.params, f.params);
  assert.deepEqual(draft.context, { ...f.context, refs: [...f.context.refs, { assetId: f.candidate.assetId, role: 'reference' }] });
  assert.equal(f.jobs.getJob(f.job.jobId).snapshot.context.refs.length, 1); assert.equal(f.jobs.listJobs().length, 1); assert.deepEqual(f.calls, []);
});
test('candidate belonging to another job or missing/corrupted input fails before creating a draft', async t => {
  const f = await fixture(t), count = f.jobs.listDrafts().length;
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'foreign-result' }), { code: 'RESULT_NOT_FOUND' });
  const read = f.assets.read;
  for (const missing of [f.context.baseAssetId, f.context.selectionMaskAssetId, f.context.refs[0].assetId, f.candidate.assetId]) {
    f.assets.read = async id => { if (id === missing) throw new DomainError('ASSET_NOT_FOUND', 'Fixture asset is missing', 404); return read(id); };
    await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'ASSET_NOT_FOUND' });
  }
  f.assets.read = async id => { const value = await read(id); if (id === f.candidate.assetId) value.asset.source.jobId = 'foreign-job'; return value; };
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'ASSET_CONTEXT_CONFLICT' });
  assert.equal(f.jobs.listDrafts().length, count); assert.deepEqual(f.calls, []);
});
test('candidate reference budget failures preserve old references and offer an original-input draft', async t => {
  const f = await fixture(t), count = f.jobs.listDrafts().length;
  f.limits.inputImages = 3;
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'REFERENCE_LIMIT' });
  f.limits.inputImages = 14; f.limits.inputBytes = 1;
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'REFERENCE_LIMIT' });
  f.model = 'different-model';
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'REFERENCE_LIMIT_UNKNOWN' });
  f.model = 'fixture-model'; f.limits = {};
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'REFERENCE_LIMIT_UNKNOWN' });
  assert.equal(f.jobs.listDrafts().length, count);
  assert.deepEqual((await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original' })).context.refs, f.context.refs);
});
test('candidate budget uses the historical explicit model when the adapter supports model-specific discovery', async t => {
  const f = await fixture(t); f.model = 'new-default-model';
  f.describe = input => { assert.equal(input.model, 'fixture-model'); return { model: input.model, defaultModel: f.model, limits: f.limits }; };
  const draft = await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' });
  assert.equal(draft.params.model, 'fixture-model'); assert.equal(draft.context.refs.length, 2); assert.deepEqual(f.calls, []);
});
test('both draft modes preserve the actual historical model after the service default changes', async t => {
  const f = await fixture(t, { noExplicitModel: true, recordedModel: 'historical-model' }); f.model = 'new-default-model';
  f.describe = input => { assert.equal(input.model, 'historical-model'); return { model: input.model, defaultModel: f.model, limits: f.limits }; };
  for (const mode of ['original', 'candidate-reference']) {
    const draft = await f.service.deriveDraft({ jobId: f.job.jobId, mode, ...(mode === 'candidate-reference' ? { resultId: 'candidate-1' } : {}) });
    assert.deepEqual(draft.params, { ...f.params, model: 'historical-model' });
  }
  assert.equal(f.jobs.getJob(f.job.jobId).snapshot.params.model, undefined); assert.deepEqual(f.calls, []);
});
test('model records that contradict explicit parameters fail without rewriting either model', async t => {
  const f = await fixture(t, { recordedModel: 'different-model' }), count = f.jobs.listDrafts().length;
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original' }), { code: 'MODEL_CONTEXT_CONFLICT' });
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'MODEL_CONTEXT_CONFLICT' });
  assert.equal(f.jobs.listDrafts().length, count); assert.equal(f.jobs.getJob(f.job.jobId).snapshot.params.model, 'fixture-model');
  const equivalent = await fixture(t, { params: { model: ' models/fixture-model ' }, recordedModel: 'fixture-model' });
  assert.equal((await equivalent.service.deriveDraft({ jobId: equivalent.job.jobId, mode: 'original' })).params.model, ' models/fixture-model ');
});
test('missing historical model stays unset in original mode and cannot use the current default as a candidate budget', async t => {
  const f = await fixture(t, { noExplicitModel: true });
  f.describe = () => { throw Error('Must not guess a model from current configuration'); };
  assert.equal((await f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original' })).params.model, undefined);
  const count = f.jobs.listDrafts().length;
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference', resultId: 'candidate-1' }), { code: 'REFERENCE_LIMIT_UNKNOWN' });
  assert.equal(f.jobs.listDrafts().length, count); assert.deepEqual(f.calls, []);
});
test('derivation rejects ambiguous modes and native layer jobs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'original', resultId: 'candidate-1' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.deriveDraft({ jobId: f.job.jobId, mode: 'candidate-reference' }), { code: 'INVALID_INPUT' });
  const native = f.jobs.createDraft({ capabilityId: 'ps.layer.update', params: { layerId: 2, changes: { opacity: 50 } }, context: f.context });
  const { job } = f.jobs.createJob({ draftId: native.draftId, expectedRevision: 1, requestId: 'native-request' });
  await assert.rejects(f.service.deriveDraft({ jobId: job.jobId, mode: 'original' }), { code: 'CAPABILITY_CONFLICT' }); assert.deepEqual(f.calls, []);
});
