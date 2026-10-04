const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createJobStore } = require('../companion/jobs');
const { validateReviewFeedback, reviewFeedbackSchema, MAX_REVIEW_FEEDBACK_BYTES } = require('../companion/domain/contracts');
const fixture = require('../companion/domain/fixtures');
const copy = value => JSON.parse(JSON.stringify(value));
const emptyReview = { revision: 0, feedback: [], acceptance: null };
const feedback = { items: [{ category: 'lighting', description: 'The face is too dark', area: 'face', requestedChange: 'Lift the face without changing the background' }], preserve: ['Keep the character identity'] };
function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxd-result-review-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createJobStore({ rootDir }), file = path.join(rootDir, 'state.json');
  function submit(requestId = 'generation-1', input = fixture.draft, lineage) {
    const draft = lineage ? store.createDerivedDraft(copy(input), lineage) : store.createDraft(copy(input));
    const job = store.createJob({ draftId: draft.draftId, expectedRevision: draft.revision, requestId }).job;
    return { draft, job };
  }
  function candidate(jobId, resultId = 'candidate-1') {
    store.addResults(jobId, [{ resultId, assetId: 'asset-' + resultId, provider: { id: 'fixture', model: 'fixture-model' } }]);
    return resultId;
  }
  return { rootDir, file, store, submit, candidate, restart: () => createJobStore({ rootDir }) };
}
function request(jobId, resultId = 'candidate-1', extra = {}) {
  return { jobId, resultId, expectedReviewRevision: 0, requestId: 'review-1', ...extra };
}
function rewrite(file, state) {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: createHash('sha256').update(JSON.stringify(state)).digest('hex'), state }));
}
test('old jobs have read-only empty review semantics and no migration or invented persisted fields', t => {
  const { store, submit, file, restart } = setup(t), { job } = submit();
  const before = fs.readFileSync(file);
  assert.equal(Object.hasOwn(JSON.parse(before).state, 'reviewRequests'), false);
  assert.deepEqual(restart().getJobReview(job.jobId), { jobId: job.jobId, review: emptyReview, previousAccepted: null });
  assert.equal(Object.hasOwn(store.getJob(job.jobId), 'review'), false);
  assert.equal(Object.hasOwn(store.listJobs()[0], 'review'), false);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('UI and Agent share review revisions while every generation, draft and placement field stays unchanged', t => {
  const { store, submit, candidate, file, restart } = setup(t), { draft, job } = submit(); candidate(job.jobId);
  store.transition(job.jobId, 'running'); store.transition(job.jobId, 'succeeded');
  store.setPlacement(job.jobId, { status: 'queued', requestId: 'place-1' }); store.setPlacement(job.jobId, { status: 'applying' });
  store.setPlacement(job.jobId, { status: 'applied', receipt: { jobId: job.jobId, mutationId: 'place-1', createdLayerIds: [3], rollbackStatus: 'available' } });
  const beforeJob = store.getJob(job.jobId), beforeDraft = store.getDraft(draft.draftId);
  const ui = store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback: copy(feedback), source: 'ui' }));
  assert.equal(ui.duplicate, false); assert.equal(ui.appliedRevision, 1); assert.equal(ui.review.revision, 1);
  assert.deepEqual(ui.review.feedback[0], { resultId: 'candidate-1', ...feedback, recordedVia: 'ui', updatedAt: ui.review.updatedAt });
  const accepted = restart().setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'review-2', source: 'agent' }));
  assert.equal(accepted.review.revision, 2); assert.equal(accepted.review.acceptance.recordedVia, 'agent');
  assert.equal(accepted.review.feedback[0].recordedVia, 'ui');
  const { review, ...afterJob } = store.getJob(job.jobId);
  assert.deepEqual(afterJob, beforeJob); assert.deepEqual(store.getDraft(draft.draftId), beforeDraft);
  assert.deepEqual(review, accepted.review); assert.deepEqual(store.listJobs()[0].review, accepted.review);
  const state = JSON.parse(fs.readFileSync(file)).state;
  assert.deepEqual(Object.keys(state.reviewRequests[0]).sort(), ['appliedRevision', 'jobId', 'operation', 'payloadHash', 'requestId']);
  assert.ok(!JSON.stringify(state.reviewRequests).includes(feedback.items[0].description));
  assert.equal(Object.hasOwn(store.getJobReview(job.jobId), 'reviewRequests'), false);
});
test('concurrent revision-zero writes conflict and duplicate promises produce one durable review update', async t => {
  const { store, submit, candidate, restart } = setup(t), { job } = submit(); candidate(job.jobId);
  const outcomes = await Promise.allSettled(['ui', 'agent'].map(source => Promise.resolve().then(() => store.updateResultFeedback(request(job.jobId, 'candidate-1', { requestId: 'concurrent-' + source, feedback, source })))));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected').reason;
  assert.equal(rejected.code, 'REVIEW_REVISION_CONFLICT'); assert.equal(rejected.status, 409);
  assert.equal(rejected.details.jobId, job.jobId); assert.equal(rejected.details.current.revision, 1);
  rejected.details.current.feedback[0].items[0].description = 'mutated conflict';
  assert.equal(restart().getJobReview(job.jobId).review.feedback[0].items[0].description, feedback.items[0].description);
  const input = request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'accept-concurrent' });
  const repeated = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => store.setAcceptedResult(input))));
  assert.equal(repeated.filter(result => !result.duplicate).length, 1);
  assert.ok(repeated.every(result => result.appliedRevision === 2 && result.review.revision === 2));
});
test('restart retries return current review and initial applied revision without changing first recordedVia', t => {
  const { store, submit, candidate, file, restart } = setup(t), { job } = submit('shared-request'); candidate(job.jobId);
  const first = request(job.jobId, 'candidate-1', { requestId: 'shared-request', feedback, source: 'ui' });
  store.updateResultFeedback(first);
  store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'accept', source: 'agent' }));
  const before = fs.readFileSync(file);
  const reordered = { preserve: feedback.preserve.slice(), items: [{ requestedChange: feedback.items[0].requestedChange, area: 'face', description: feedback.items[0].description, category: 'lighting' }] };
  const duplicate = restart().updateResultFeedback({ ...first, feedback: reordered, source: 'system' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.appliedRevision, 1); assert.equal(duplicate.review.revision, 2);
  assert.equal(duplicate.review.feedback[0].recordedVia, 'ui'); assert.equal(duplicate.review.acceptance.recordedVia, 'agent');
  assert.deepEqual(fs.readFileSync(file), before, 'a replay does not save or rewrite attribution');
  const generation = restart().createJob({ draftId: job.draftId, expectedRevision: 1, requestId: 'shared-request' });
  assert.equal(generation.duplicate, true, 'generation and review request namespaces are independent');
});
test('request reuse with another valid payload, job, candidate, expected revision or operation is rejected', t => {
  const { store, submit, candidate, file } = setup(t), { job } = submit(), other = submit('generation-2').job;
  candidate(job.jobId); candidate(job.jobId, 'candidate-2'); candidate(other.jobId, 'foreign-candidate');
  const first = request(job.jobId, 'candidate-1', { feedback }); store.updateResultFeedback(first);
  const before = fs.readFileSync(file);
  for (const patch of [
    { feedback: null }, { feedback: { ...feedback, preserve: [] } }, { jobId: other.jobId, resultId: 'foreign-candidate' },
    { resultId: 'candidate-2' }, { expectedReviewRevision: 1 },
  ]) assert.throws(() => store.updateResultFeedback({ ...first, ...patch }), { code: 'REQUEST_CONFLICT', status: 409 });
  assert.throws(() => store.setAcceptedResult(request(job.jobId)), { code: 'REQUEST_CONFLICT', status: 409 });
  assert.deepEqual(fs.readFileSync(file), before);
});
test('candidate acceptance, replacement, feedback deletion and explicit acceptance clearing remain independent', t => {
  const { store, submit, candidate, restart } = setup(t), { job } = submit(); candidate(job.jobId); candidate(job.jobId, 'candidate-2');
  store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback }));
  store.updateResultFeedback(request(job.jobId, 'candidate-2', { feedback: { items: [], preserve: ['The pose'] }, expectedReviewRevision: 1, requestId: 'feedback-2' }));
  store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 2, requestId: 'accept-1' }));
  const replaced = store.setAcceptedResult(request(job.jobId, 'candidate-2', { expectedReviewRevision: 3, requestId: 'accept-2', source: 'agent' }));
  assert.equal(replaced.review.acceptance.resultId, 'candidate-2'); assert.equal(replaced.review.feedback.length, 2);
  const deleted = store.updateResultFeedback(request(job.jobId, 'candidate-2', { feedback: null, expectedReviewRevision: 4, requestId: 'delete-feedback', source: 'agent' }));
  assert.deepEqual(deleted.review.feedback.map(item => item.resultId), ['candidate-1']);
  assert.equal(deleted.review.acceptance.resultId, 'candidate-2', 'deleting feedback does not unaccept a result');
  const cleared = store.setAcceptedResult(request(job.jobId, null, { expectedReviewRevision: 5, requestId: 'clear', source: 'system' }));
  assert.deepEqual(cleared.review.acceptance, { resultId: null, recordedVia: 'system', updatedAt: cleared.review.updatedAt });
  assert.equal(cleared.review.feedback[0].resultId, 'candidate-1');
  assert.deepEqual(restart().getJobReview(job.jobId).review, cleared.review);
});
test('late results on cancelled, failed and recovery-required jobs can be reviewed without reviving side effects', t => {
  for (const status of ['cancelled', 'failed', 'recovery-required']) {
    const { store, submit, candidate } = setup(t), { job } = submit();
    store.transition(job.jobId, 'running'); store.transition(job.jobId, status);
    candidate(job.jobId); const before = store.getJob(job.jobId);
    store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback }));
    store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'accept-late' }));
    const { review, ...after } = store.getJob(job.jobId);
    assert.deepEqual(after, before); assert.equal(review.acceptance.resultId, 'candidate-1');
    assert.equal(after.status, status); assert.deepEqual(after.placement, { status: 'not-requested' });
  }
});
test('review requires an image-edit job and its own candidate, with exact revision and bounded structured feedback', t => {
  const { store, submit, candidate, file } = setup(t), { job } = submit(), other = submit('other').job;
  candidate(job.jobId); candidate(other.jobId, 'foreign');
  const native = submit('native', { capabilityId: 'ps.layer.update', params: { layerId: 3, changes: { opacity: 60 } }, context: fixture.context }).job;
  const before = fs.readFileSync(file);
  for (const expectedReviewRevision of [-1, 0.5, '0', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision })), { code: 'INVALID_INPUT' });
  }
  for (const bad of [null, {}, { items: [] }, { preserve: [] }, { items: [], preserve: [], extra: 1 }, { items: [{ category: 'bogus', description: 'x' }], preserve: [] }, { items: [{ category: 'detail', description: '' }], preserve: [] }, { items: [{ category: 'detail', description: 'x', area: '' }], preserve: [] }, { items: [], preserve: [''] }, { items: [], preserve: Array(21).fill('x') }, { items: Array(21).fill({ category: 'other', description: 'x' }), preserve: [] }]) {
    assert.throws(() => validateReviewFeedback(bad), { code: 'INVALID_INPUT' });
  }
  for (const bad of [
    { items: [], preserve: [], toString: 'not a declared field' },
    { items: [{ category: 'other', description: 'x', hasOwnProperty: 'not a declared field' }], preserve: [] },
    { items: [{ category: 'other', description: 'x'.repeat(2001) }], preserve: [] },
    { items: [{ category: 'other', description: 'x', area: 'x'.repeat(121) }], preserve: [] },
    { items: [{ category: 'other', description: 'x', requestedChange: 'x'.repeat(2001) }], preserve: [] },
    { items: [], preserve: ['x'.repeat(501)] },
    { items: Array(1), preserve: [] },
  ]) assert.throws(() => validateReviewFeedback(bad), { code: 'INVALID_INPUT' });
  const huge = { items: Array.from({ length: 20 }, () => ({ category: 'other', description: '界'.repeat(2000) })), preserve: [] };
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > MAX_REVIEW_FEEDBACK_BYTES);
  assert.throws(() => store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback: huge })), { code: 'INVALID_INPUT' });
  for (const invoke of [
    () => store.updateResultFeedback(request(job.jobId, 'foreign', { feedback })),
    () => store.setAcceptedResult(request(job.jobId, 'missing')),
  ]) assert.throws(invoke, { code: 'RESULT_NOT_FOUND' });
  assert.throws(() => store.setAcceptedResult(request(native.jobId, null)), { code: 'CAPABILITY_CONFLICT' });
  assert.throws(() => store.getJobReview(native.jobId), { code: 'CAPABILITY_CONFLICT' });
  assert.throws(() => store.setAcceptedResult(request('missing-job', null)), { code: 'JOB_NOT_FOUND' });
  assert.throws(() => store.setAcceptedResult(request(job.jobId, null, { source: 'human' })), { code: 'INVALID_INPUT' });
  assert.throws(() => store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback, requestId: '' })), { code: 'INVALID_INPUT' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(reviewFeedbackSchema.required, ['items', 'preserve']);
});
test('nearest currently accepted ancestor is explicit provenance and does not initialize or clear a child review', t => {
  const { store, submit, candidate, file, restart } = setup(t), { job: root } = submit('root'); candidate(root.jobId, 'root-result');
  const rootReview = store.setAcceptedResult(request(root.jobId, 'root-result', { source: 'ui' }));
  const child = submit('child', fixture.draft, { sourceJobId: root.jobId, mode: 'original' }).job; candidate(child.jobId, 'child-result');
  const grandchild = submit('grandchild', fixture.draft, { sourceJobId: child.jobId, mode: 'candidate-reference', sourceResultId: 'child-result' }).job;
  const before = fs.readFileSync(file), first = store.getJobReview(grandchild.jobId);
  assert.deepEqual(first.review, emptyReview);
  assert.deepEqual(first.previousAccepted, { jobId: root.jobId, resultId: 'root-result', reviewRevision: 1, recordedVia: 'ui', updatedAt: rootReview.review.acceptance.updatedAt });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(Object.hasOwn(store.getJob(child.jobId), 'review'), false);
  store.setAcceptedResult(request(child.jobId, 'child-result', { requestId: 'accept-child', source: 'agent' }));
  assert.equal(restart().getJobReview(grandchild.jobId).previousAccepted.jobId, child.jobId);
  const childSnapshot = store.getJob(child.jobId).snapshot;
  store.setAcceptedResult(request(child.jobId, null, { expectedReviewRevision: 1, requestId: 'clear-child', source: 'agent' }));
  assert.equal(restart().getJobReview(grandchild.jobId).previousAccepted.jobId, root.jobId);
  assert.equal(store.getJobReview(child.jobId).review.acceptance.resultId, null);
  assert.equal(store.getJobReview(root.jobId).review.acceptance.resultId, 'root-result');
  assert.deepEqual(store.getJob(child.jobId).snapshot, childSnapshot);
  store.setAcceptedResult(request(root.jobId, null, { expectedReviewRevision: 1, requestId: 'clear-root' }));
  assert.equal(store.getJobReview(grandchild.jobId).previousAccepted, null);
});
test('inputs, successful responses, list/get results and ancestry details never alias persisted review state', t => {
  const { store, submit, candidate, restart } = setup(t), { job } = submit(); candidate(job.jobId);
  const input = copy(feedback), written = store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback: input }));
  input.items[0].description = 'mutated input'; written.review.feedback[0].preserve[0] = 'mutated response';
  const accepted = store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'accept' }));
  accepted.review.acceptance.resultId = 'mutated response';
  const child = submit('child', fixture.draft, { sourceJobId: job.jobId, mode: 'original' }).job;
  store.getJobReview(child.jobId).previousAccepted.resultId = 'mutated ancestry';
  store.getJobReview(job.jobId).review.feedback[0].items[0].description = 'mutated get';
  store.listJobs().find(item => item.jobId === job.jobId).review.feedback.length = 0;
  store.getJob(job.jobId).review.acceptance.resultId = null;
  const actual = restart().getJobReview(job.jobId).review;
  assert.deepEqual(actual.feedback[0].items, feedback.items); assert.deepEqual(actual.feedback[0].preserve, feedback.preserve);
  assert.equal(actual.acceptance.resultId, 'candidate-1');
});
test('review and request dedupe publish together and a failed atomic rename leaves neither mutation visible', t => {
  const { store, submit, candidate, file, restart } = setup(t), { job } = submit(); candidate(job.jobId);
  const before = fs.readFileSync(file), input = request(job.jobId, 'candidate-1', { feedback }), originalRename = fs.renameSync;
  fs.renameSync = (...args) => { if (String(args[0]).includes(path.sep + '.state-')) throw new Error('fixture rename failure'); return originalRename(...args); };
  try { assert.throws(() => store.updateResultFeedback(input), { code: 'STORAGE_UNAVAILABLE' }); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(restart().getJobReview(job.jobId).review, emptyReview);
  const retry = restart().updateResultFeedback(input);
  assert.equal(retry.duplicate, false); assert.equal(retry.appliedRevision, 1);
  assert.equal(restart().updateResultFeedback(input).duplicate, true);
});
test('post-rename durability failure can be resolved by the same request without replaying a review write', t => {
  const { store, submit, candidate, file, restart, rootDir } = setup(t), { job } = submit(); candidate(job.jobId);
  const input = request(job.jobId, 'candidate-1', { feedback }), originalOpen = fs.openSync;
  if (process.platform === 'win32') { t.skip('Windows deliberately does not open directory handles'); return; }
  fs.openSync = (file, ...args) => { if (file === fs.realpathSync(rootDir)) throw new Error('fixture directory sync failure'); return originalOpen(file, ...args); };
  try { assert.throws(() => store.updateResultFeedback(input), { code: 'STORAGE_UNAVAILABLE' }); }
  finally { fs.openSync = originalOpen; }
  const beforeRetry = fs.readFileSync(file), duplicate = restart().updateResultFeedback(input);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.appliedRevision, 1); assert.equal(duplicate.review.revision, 1);
  assert.deepEqual(fs.readFileSync(file), beforeRetry);
});
test('stored review fields, ownership, duplicate entries and request history corruption fail closed', t => {
  const { store, submit, candidate, file, restart } = setup(t), { job } = submit(), foreign = submit('foreign').job;
  candidate(job.jobId); candidate(foreign.jobId, 'foreign-result');
  store.updateResultFeedback(request(job.jobId, 'candidate-1', { feedback }));
  store.setAcceptedResult(request(job.jobId, 'candidate-1', { expectedReviewRevision: 1, requestId: 'accept' }));
  const valid = JSON.parse(fs.readFileSync(file)).state;
  for (const alter of [
    state => { state.jobs[0].review = null; },
    state => { state.jobs[0].review.revision = 0; },
    state => { state.jobs[0].review.extra = true; },
    state => { state.jobs[0].review.updatedAt = 'invalid'; },
    state => { delete state.jobs[0].review.acceptance; },
    state => { state.jobs[0].review.feedback.push(copy(state.jobs[0].review.feedback[0])); },
    state => { state.jobs[0].review.feedback[0].resultId = 'foreign-result'; },
    state => { state.jobs[0].review.feedback[0].items[0].category = 'unknown'; },
    state => { state.jobs[0].review.feedback[0].recordedVia = 'human'; },
    state => { state.jobs[0].review.acceptance.resultId = 'foreign-result'; },
    state => { state.jobs[0].review.acceptance.approvedBy = 'human'; },
    state => { delete state.jobs[0].review.acceptance.resultId; },
    state => { delete state.reviewRequests; },
    state => { state.reviewRequests = {}; },
    state => { state.reviewRequests.pop(); },
    state => { state.reviewRequests.push(copy(state.reviewRequests[0])); },
    state => { state.reviewRequests[1].appliedRevision = 1; },
    state => { state.reviewRequests[0].jobId = foreign.jobId; },
    state => { state.reviewRequests[0].jobId = 'missing-job'; },
    state => { state.reviewRequests[0].payloadHash = 'not-a-hash'; },
    state => { state.reviewRequests[0].operation = 'run'; },
    state => { state.reviewRequests[0].feedback = feedback; },
  ]) {
    const state = copy(valid); alter(state); rewrite(file, state);
    assert.throws(restart, { code: 'STORAGE_CORRUPT' });
    assert.throws(() => store.getJobReview(job.jobId), { code: 'STORAGE_CORRUPT' });
  }
  rewrite(file, valid); assert.equal(restart().getJobReview(job.jobId).review.revision, 2);
});
test('cyclic stored ancestry fails closed instead of looping even if every lineage reference is otherwise valid', t => {
  const { store, submit, candidate, file, restart } = setup(t), { job: first } = submit(); candidate(first.jobId);
  const { job: second } = submit('second', fixture.draft, { sourceJobId: first.jobId, mode: 'original' });
  const state = JSON.parse(fs.readFileSync(file)).state;
  const lineage = { sourceJobId: second.jobId, mode: 'original' };
  state.drafts.find(draft => draft.draftId === first.draftId).lineage = lineage;
  state.jobs.find(job => job.jobId === first.jobId).snapshot.lineage = lineage;
  rewrite(file, state);
  assert.throws(restart, { code: 'STORAGE_CORRUPT' });
  assert.throws(() => store.getJobReview(second.jobId), { code: 'STORAGE_CORRUPT' });
});
