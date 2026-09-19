const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createCapabilityService } = require('../companion/capabilities/service');
const { DomainError, clone } = require('../companion/domain/contracts');
const { context } = require('../companion/domain/fixtures');
const encode = require('../plugin/ps-encode-014');
const png = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(127), 3));
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-capability-'));
  const assets = createAssetStore({ rootDir: path.join(root, 'assets') });
  const jobs = createJobStore({ rootDir: path.join(root, 'jobs') });
  const calls = [];
  const bridge = { status: () => ({ connected: true }), request: async (name, args) => {
    calls.push({ name, args: clone(args) });
    if (options.host) { const result = await options.host(name, args); if (result !== undefined) return result; }
    if (name === 'studio_capture') return { ok: true, documentRef: clone(context.documentRef), scope: args.scope, transform: clone(context.transform), image: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 }, ...(args.scope === 'selection' ? { mask: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 } } : {}) };
    if (name === 'studio_rollback') return { ok: true, receipt: { ...args.receipt, rollbackStatus: 'rolled-back' } };
    return { ok: true, receipt: { mutationId: args.mutationId, jobId: args.jobId, documentRef: args.documentRef, createdLayerIds: [2], modifiedLayers: [], preHistoryStateId: 4, postHistoryStateId: 5, rollbackStatus: 'available' } };
  } };
  const provider = { describe: () => ({ id: 'fixture', configured: true }), generate: async (input, execution) => {
    calls.push({ name: 'generate', input });
    if (options.generate) return options.generate(input, execution);
    return { images: [{ data: png, mimeType: 'image/png' }], provider: { id: 'fixture', model: 'fixture-image' } };
  } };
  const service = createCapabilityService({ assets, jobs, provider, bridge });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const capture = await service.capture({ documentId: 1, scope: 'selection' });
  async function makeJob(extra = {}) {
    const draft = await service.createDraft({ capabilityId: 'image.edit', params: { prompt: 'Fix hair' }, context: capture, ...extra });
    const input = { draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'request-' + draft.draftId, source: 'ui' };
    const result = await service.run(input); return { draft, input, job: result.job };
  }
  return { service, jobs, assets, calls, capture, makeJob };
}
test('UI/Agent revisions share one immutable run; duplicate request never dispatches twice', async t => {
  const f = await setup(t), created = await f.makeJob();
  await f.service.updateDraft({ draftId: created.draft.draftId, expectedRevision: 1, params: { prompt: 'New revision' }, source: 'agent' });
  assert.equal((await f.service.run(created.input)).duplicate, true);
  await f.service.waitForIdle();
  const job = await f.service.getJob(created.job.jobId);
  assert.equal(job.status, 'succeeded'); assert.equal(job.snapshot.params.prompt, 'Fix hair');
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 1);
  assert.equal((await f.service.getDraft(created.draft.draftId)).source, 'agent');
});
test('old assets cannot be paired with another source document or transform', async t => {
  const f = await setup(t), other = clone(f.capture); other.documentRef.documentId = 91;
  const { job } = await f.makeJob({ context: other }); await f.service.waitForIdle();
  assert.equal((await f.service.getJob(job.jobId)).error.code, 'ASSET_CONTEXT_CONFLICT');
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 0);
});
test('apply followed by rollback and replay never performs another host mutation', async t => {
  const f = await setup(t), created = await f.makeJob(); await f.service.waitForIdle();
  const job = await f.service.getJob(created.job.jobId), input = { jobId: job.jobId, resultId: job.results[0].resultId, requestId: 'placement-once' };
  assert.equal((await f.service.apply(input)).placement.status, 'applied');
  assert.equal((await f.service.rollback({ jobId: job.jobId })).placement.status, 'rolled-back');
  assert.equal((await f.service.apply(input)).placement.status, 'rolled-back');
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 1);
});
test('uncertain host commits are not made retryable and generated assets survive', async t => {
  const f = await setup(t, { host: name => { if (name === 'studio_apply_result') throw new DomainError('HOST_RECOVERY_REQUIRED', 'Outcome unknown'); } });
  const created = await f.makeJob(); await f.service.waitForIdle();
  const job = await f.service.getJob(created.job.jobId), input = { jobId: job.jobId, resultId: job.results[0].resultId, requestId: 'uncertain' };
  const result = await f.service.apply(input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.placement.status, 'rollback-conflict'); assert.equal(result.results.length, 1);
  await assert.rejects(f.service.apply(input), { code: 'PLACEMENT_CONFLICT' });
});
test('receipt persistence failure after host success preserves uncertainty and recoverable receipt', async t => {
  const f = await setup(t), created = await f.makeJob(); await f.service.waitForIdle();
  const write = f.jobs.setPlacement;
  f.jobs.setPlacement = (id, value) => { if (value.status === 'applied') throw new DomainError('STORAGE_UNAVAILABLE', 'Injected write failure', 503); return write(id, value); };
  const job = await f.service.getJob(created.job.jobId);
  const result = await f.service.apply({ jobId: job.jobId, resultId: job.results[0].resultId, requestId: 'receipt-failure' });
  assert.equal(result.placement.status, 'rollback-conflict'); assert.equal(result.placement.error.code, 'HOST_UNCERTAIN'); assert.ok(result.placement.receipt);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 1);
});
test('native uncertain writes require recovery and do not delete original-layer evidence', async t => {
  const f = await setup(t, { host: name => { if (name === 'studio_edit_layer') throw new DomainError('HOST_RECOVERY_REQUIRED', 'Outcome unknown'); } });
  const { job } = await f.makeJob({ capabilityId: 'ps.layer.update', params: { layerId: 4, changes: { opacity: 50 } } }); await f.service.waitForIdle();
  const result = await f.service.getJob(job.jobId);
  assert.equal(result.status, 'recovery-required'); assert.equal(result.placement.status, 'rollback-conflict');
});
test('cancelled provider with late output retains its result without auto placement or revival', async t => {
  let resolveResult, enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const f = await setup(t, { generate: () => { enteredResolve(); return new Promise(resolve => { resolveResult = resolve; }); } });
  const capture = clone(f.capture); capture.settings.autoApply = true;
  const { job } = await f.makeJob({ context: capture }); await entered;
  await f.service.cancel(job.jobId);
  resolveResult({ images: [{ data: png, mimeType: 'image/png' }], provider: { id: 'fixture' } }); await f.service.waitForIdle();
  const result = await f.service.getJob(job.jobId);
  assert.equal(result.status, 'cancelled'); assert.equal(result.results.length, 1);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
