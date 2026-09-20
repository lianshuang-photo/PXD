const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createJobStore } = require('../companion/jobs');
const fixture = require('../companion/domain/fixtures');
const copy = value => JSON.parse(JSON.stringify(value));
function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxd-jobs-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createJobStore({ rootDir });
  function submit(requestId = 'request-1', input = fixture.draft) {
    const draft = store.createDraft(copy(input));
    return { draft, job: store.createJob({ draftId: draft.draftId, expectedRevision: draft.revision, requestId }).job };
  }
  return { rootDir, store, submit, restart: () => createJobStore({ rootDir }) };
}
test('incomplete drafts persist; a stale UI/agent update exposes the current revision without replacing it', t => {
  const { store, restart } = setup(t);
  const draft = store.createDraft({ capabilityId: 'image.edit' });
  assert.equal(draft.revision, 1); assert.equal(draft.context, null);
  assert.throws(() => store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'incomplete' }), { code: 'CONTEXT_REQUIRED' });
  const updated = store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'Change lighting' }, source: 'agent' });
  assert.equal(updated.revision, 2); assert.equal(updated.source, 'agent');
  assert.throws(() => store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'stale' }, source: 'ui' }), error => {
    assert.equal(error.code, 'REVISION_CONFLICT'); assert.equal(error.status, 409); assert.deepEqual(error.details.current, updated);
    error.details.current.params.prompt = 'mutated error'; return true;
  });
  assert.deepEqual(restart().getDraft(draft.draftId), updated);
  assert.deepEqual(store.listDrafts(), [updated]);
});
test('submitted pixels/refs/mask/params remain an immutable snapshot after caller and draft edits', t => {
  const { store, restart } = setup(t), input = copy(fixture.draft);
  input.context.refs = [{ assetId: 'asset-ref', role: 'identity' }]; input.params.temperature = 0.5;
  const draft = store.createDraft(input), { job } = store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'snapshot' });
  input.context.refs[0].assetId = 'mutated'; input.params.temperature = 2;
  draft.context.selectionMaskAssetId = 'mutated-mask'; job.snapshot.params.temperature = 1.5;
  const context = copy(fixture.context); context.refs = []; context.baseAssetId = 'new-base';
  store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'next prompt' }, context });
  const stored = restart().getJob(job.jobId);
  assert.equal(stored.snapshot.revision, 1); assert.equal(stored.snapshot.params.temperature, 0.5);
  assert.equal(stored.snapshot.context.baseAssetId, fixture.context.baseAssetId);
  assert.equal(stored.snapshot.context.selectionMaskAssetId, fixture.context.selectionMaskAssetId);
  assert.equal(stored.snapshot.context.refs[0].assetId, 'asset-ref');
  assert.equal(store.getDraft(draft.draftId).params.temperature, 0.5, 'draft updates shallow-merge parameters');
});
test('unsetParams removes only named parameters at the expected revision and survives restart without changing prior jobs', t => {
  const { store, restart } = setup(t);
  const draft = store.createDraft({ ...copy(fixture.draft), params: { prompt: 'Original', model: 'gemini-3-pro-image-preview', imageSize: '2K', temperature: 0.5 } });
  const { job } = store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'before-reset' });
  const updated = store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, unsetParams: ['model', 'imageSize', 'temperature'], params: { prompt: 'Use model defaults' }, source: 'agent' });
  assert.deepEqual(updated.params, { prompt: 'Use model defaults' }); assert.equal(updated.revision, 2);
  assert.deepEqual(restart().getDraft(draft.draftId).params, updated.params);
  assert.equal(restart().getJob(job.jobId).snapshot.params.imageSize, '2K');
  assert.throws(() => store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, unsetParams: ['prompt'] }), { code: 'REVISION_CONFLICT' });
  for (const patch of [{ unsetParams: ['bogus'] }, { unsetParams: ['model', 'model'] }, { unsetParams: ['__proto__'] }, { unsetParams: ['imageSize'], params: { imageSize: '1K' } }, { unsetParams: null }]) {
    assert.throws(() => store.updateDraft({ draftId: draft.draftId, expectedRevision: 2, ...patch }), { code: 'INVALID_INPUT' });
    assert.equal(store.getDraft(draft.draftId).revision, 2);
  }
  const reapplied = store.updateDraft({ draftId: draft.draftId, expectedRevision: 2, params: { imageSize: '1K' } }); assert.equal(reapplied.params.imageSize, '1K');
});
test('duplicate request lookup precedes stale revision checks and survives restart; conflicting reuse fails', t => {
  const { store, submit, restart } = setup(t), { draft, job } = submit('dedupe');
  store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'next' } });
  const duplicate = restart().createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'dedupe', source: 'agent' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.jobId, job.jobId);
  assert.throws(() => store.createJob({ draftId: draft.draftId, expectedRevision: 2, requestId: 'dedupe' }), { code: 'REQUEST_CONFLICT' });
  const other = store.createDraft(copy(fixture.draft));
  assert.throws(() => store.createJob({ draftId: other.draftId, expectedRevision: 1, requestId: 'dedupe' }), { code: 'REQUEST_CONFLICT' });
  assert.throws(() => store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'different' }), { code: 'REVISION_CONFLICT' });
  assert.equal(store.listJobs().length, 1);
});
test('concurrent promises cannot double-submit or overwrite a draft revision within its owning process', async t => {
  const { store } = setup(t), draft = store.createDraft(copy(fixture.draft));
  const submitted = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'concurrent' }))));
  assert.equal(submitted.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(submitted.map(result => result.job.jobId)).size, 1);
  const updates = await Promise.allSettled(['a', 'b'].map(prompt => Promise.resolve().then(() => store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt } }))));
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(updates.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
});
test('terminal transitions cannot revive cancellation; late results remain inspectable and idempotent', t => {
  const { store, submit, restart } = setup(t), { job } = submit('cancelled');
  store.transition(job.jobId, 'running'); store.cancel(job.jobId);
  const afterRestart = restart(); assert.equal(afterRestart.getJob(job.jobId).status, 'cancelled');
  const result = { resultId: 'result-late', assetId: 'asset-output', provider: { id: 'gemini', model: 'fixture' } };
  const late = afterRestart.addResults(job.jobId, [result]);
  assert.equal(late.status, 'cancelled'); assert.equal(late.placement.status, 'not-requested'); assert.equal(late.results.length, 1);
  assert.deepEqual(afterRestart.addResults(job.jobId, [result]), late);
  assert.throws(() => store.transition(job.jobId, 'succeeded'), { code: 'STATE_CONFLICT' });
  assert.throws(() => store.setPlacement(job.jobId, { status: 'queued', requestId: 'too-late' }), { code: 'STATE_CONFLICT' });
  result.provider.model = 'caller-mutated'; late.results[0].assetId = 'caller-mutated';
  assert.equal(store.getJob(job.jobId).results[0].provider.model, 'fixture');
});
test('results have immutable identities and conflicting batches make no partial changes', t => {
  const { store, submit } = setup(t), { job } = submit('results');
  const first = store.addResults(job.jobId, [{ resultId: 'result-1', assetId: 'asset-first', provider: { id: 'fixture' } }]);
  assert.equal(first.results[0].index, 0); assert.equal(first.results[0].jobId, job.jobId);
  assert.throws(() => store.addResults(job.jobId, [{ resultId: 'result-2', assetId: 'asset-next' }, { resultId: 'result-1', assetId: 'asset-overwrite' }]), { code: 'RESULT_CONFLICT' });
  assert.deepEqual(store.getJob(job.jobId).results, first.results);
  const secondJob = submit('other-results').job;
  assert.throws(() => store.addResults(secondJob.jobId, [{ resultId: 'result-1', assetId: 'asset-first' }]), { code: 'RESULT_CONFLICT' });
});
test('native execution can persist placement separately from a successful job with no image results', t => {
  const { store, submit, restart } = setup(t);
  const { job } = submit('native', { capabilityId: 'ps.layer.update', params: { layerId: 3, changes: { opacity: 60 } }, context: fixture.context });
  store.transition(job.jobId, 'running');
  store.setPlacement(job.jobId, { status: 'queued', requestId: 'native-write' });
  store.setPlacement(job.jobId, { status: 'applying' });
  const receipt = { jobId: job.jobId, mutationId: 'native-write', modifiedLayers: [{ id: 3, before: { opacity: 100 }, after: { opacity: 60 } }], rollbackStatus: 'available' };
  store.setPlacement(job.jobId, { status: 'applied', receipt });
  const completed = store.transition(job.jobId, 'succeeded');
  assert.equal(completed.placement.status, 'applied'); assert.deepEqual(completed.results, []);
  assert.deepEqual(restart().getJob(job.jobId), completed);
});
test('placement retries are idempotent, requests conflict, receipts stay immutable across rollback', t => {
  const { store, submit, restart } = setup(t), { job } = submit('placement');
  store.transition(job.jobId, 'running');
  store.addResults(job.jobId, [{ resultId: 'result-placement', assetId: 'asset-ready' }]);
  store.transition(job.jobId, 'succeeded');
  store.setPlacement(job.jobId, { status: 'queued', requestId: 'place-1' });
  assert.throws(() => store.setPlacement(job.jobId, { status: 'queued', requestId: 'place-2' }), { code: 'PLACEMENT_CONFLICT' });
  store.setPlacement(job.jobId, { status: 'applying' });
  const receipt = { jobId: job.jobId, mutationId: 'place-1', createdLayerIds: [4], rollbackStatus: 'available' };
  const applied = store.setPlacement(job.jobId, { status: 'applied', receipt });
  assert.deepEqual(restart().setPlacement(job.jobId, { status: 'queued', requestId: 'place-1' }), applied);
  assert.throws(() => store.setPlacement(job.jobId, { status: 'queued', requestId: 'place-2' }), { code: 'PLACEMENT_CONFLICT' });
  assert.throws(() => store.setPlacement(job.jobId, { status: 'rolled-back', receipt: { ...receipt, createdLayerIds: [9] } }), { code: 'PLACEMENT_CONFLICT' });
  const rolledBack = store.setPlacement(job.jobId, { status: 'rolled-back' });
  assert.equal(rolledBack.status, 'succeeded'); assert.equal(rolledBack.results.length, 1);
  assert.deepEqual(rolledBack.placement.receipt, receipt);
  assert.equal(store.setPlacement(job.jobId, { status: 'queued', requestId: 'place-1' }).placement.status, 'rolled-back');
});
test('a failed host attempt preserves generation output and a known failure can be retried explicitly', t => {
  const { store, submit } = setup(t), { job } = submit('failed-place');
  store.transition(job.jobId, 'running'); store.addResults(job.jobId, [{ resultId: 'result-failed-place', assetId: 'asset-keep' }]); store.transition(job.jobId, 'succeeded');
  store.setPlacement(job.jobId, { status: 'queued', requestId: 'failed-place-1' }); store.setPlacement(job.jobId, { status: 'applying' });
  const failed = store.setPlacement(job.jobId, { status: 'failed', error: { code: 'HOST_UNAVAILABLE', message: 'Photoshop is unavailable' } });
  assert.equal(failed.status, 'succeeded'); assert.equal(failed.results[0].assetId, 'asset-keep');
  const retried = store.setPlacement(job.jobId, { status: 'queued', requestId: 'failed-place-2' });
  assert.equal(retried.placement.requestId, 'failed-place-2'); assert.equal(retried.placement.error, undefined);
});
test('restart recovery never dispatches queued/running work or blindly repeats interrupted host writes', t => {
  const { store, submit, restart } = setup(t);
  const queued = submit('queued').job, running = submit('running').job, finished = submit('finished').job, cancelled = submit('cancelled').job;
  store.transition(running.jobId, 'running'); store.setPlacement(running.jobId, { status: 'queued', requestId: 'interrupted-host' }); store.setPlacement(running.jobId, { status: 'applying' });
  store.transition(finished.jobId, 'running'); store.transition(finished.jobId, 'succeeded'); store.setPlacement(finished.jobId, { status: 'queued', requestId: 'interrupted-queue' });
  store.cancel(cancelled.jobId);
  const recovered = restart(), changes = recovered.recover();
  assert.equal(changes.length, 3);
  assert.equal(recovered.getJob(queued.jobId).status, 'recovery-required');
  assert.equal(recovered.getJob(running.jobId).placement.status, 'rollback-conflict');
  assert.equal(recovered.getJob(finished.jobId).status, 'succeeded');
  assert.equal(recovered.getJob(finished.jobId).placement.status, 'rollback-conflict');
  assert.equal(recovered.getJob(cancelled.jobId).status, 'cancelled');
  assert.deepEqual(recovered.recover(), []);
  assert.throws(() => recovered.transition(running.jobId, 'running'), { code: 'STATE_CONFLICT' });
  assert.equal(recovered.cancel(running.jobId).status, 'cancelled');
  assert.equal(recovered.cancel(finished.jobId).status, 'succeeded');
});
test('atomic publication failure preserves the previous authoritative state and request dedupe', t => {
  const { rootDir, store, submit, restart } = setup(t), { draft, job } = submit('durable');
  const before = fs.readFileSync(path.join(rootDir, 'state.json')), originalRename = fs.renameSync;
  fs.renameSync = (...args) => { if (String(args[0]).includes(path.sep + '.state-')) throw new Error('fixture rename failure'); return originalRename(...args); };
  try {
    assert.throws(() => store.transition(job.jobId, 'running'), { code: 'STORAGE_UNAVAILABLE' });
    assert.throws(() => store.updateDraft({ draftId: draft.draftId, expectedRevision: 1, params: { prompt: 'lost update' } }), { code: 'STORAGE_UNAVAILABLE' });
  } finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'state.json')), before);
  assert.equal(restart().getJob(job.jobId).status, 'queued');
  assert.equal(restart().createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'durable' }).duplicate, true);
});
test('crash leftovers are ignored while corrupt/missing primary storage fails closed without backup replay', t => {
  const { rootDir, store, submit, restart } = setup(t); submit('before-crash');
  const file = path.join(rootDir, 'state.json'), valid = fs.readFileSync(file);
  fs.writeFileSync(path.join(rootDir, '.state-crashed.tmp'), '{unfinished');
  assert.equal(restart().listJobs().length, 1);
  fs.writeFileSync(path.join(rootDir, 'state.json.bak'), valid);
  fs.writeFileSync(file, '{truncated');
  assert.throws(restart, { code: 'STORAGE_CORRUPT' }); assert.throws(() => store.listJobs(), { code: 'STORAGE_CORRUPT' });
  fs.writeFileSync(file, valid); fs.unlinkSync(file);
  assert.throws(restart, { code: 'STORAGE_CORRUPT' });
});
test('stored checksums and semantic validation detect altered or impossible records', t => {
  const { rootDir, submit, restart } = setup(t); submit('corrupt');
  const file = path.join(rootDir, 'state.json'), envelope = JSON.parse(fs.readFileSync(file));
  envelope.state.jobs[0].snapshot.params.prompt = 'tampered';
  fs.writeFileSync(file, JSON.stringify(envelope)); assert.throws(restart, { code: 'STORAGE_CORRUPT' });
  envelope.state.jobs[0].status = 'fictional-success';
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.state)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope)); assert.throws(restart, { code: 'STORAGE_CORRUPT' });
});
test('task APIs reject forbidden patches, raw payloads, secret metadata and mutable snapshot replacement', t => {
  const { rootDir, store, submit } = setup(t), { job } = submit('safe');
  assert.throws(() => store.transition(job.jobId, 'running', { snapshot: {} }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.transition(job.jobId, 'running', { provider: { apiKey: 'fixture-secret' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.transition(job.jobId, 'running', { provider: { url: 'https://example.test/?key=fixture-secret' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.addResults(job.jobId, [{ assetId: 'a', provider: { base64: 'AAAA' } }]), { code: 'INVALID_INPUT' });
  assert.throws(() => store.transition(job.jobId, 'failed', { error: new Error('raw error') }), { code: 'INVALID_INPUT' });
  assert.ok(!fs.readFileSync(path.join(rootDir, 'state.json'), 'utf8').includes('fixture-secret'));
});
test('Windows persistence flushes files without opening unsupported directory handles', t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxd-jobs-win-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), open = fs.openSync;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.openSync = (file, ...args) => {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw Object.assign(new Error('Windows directory handles are not exposed by Node'), { code: 'EPERM' });
    return open(file, ...args);
  };
  try {
    const store = createJobStore({ rootDir }), draft = store.createDraft(copy(fixture.draft));
    const { job } = store.createJob({ draftId: draft.draftId, expectedRevision: 1, requestId: 'win-atomic' });
    store.transition(job.jobId, 'running');
    assert.equal(createJobStore({ rootDir }).getJob(job.jobId).status, 'running');
  } finally { fs.openSync = open; Object.defineProperty(process, 'platform', platform); }
});
