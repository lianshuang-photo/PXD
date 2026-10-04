const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createCapabilityService } = require('../companion/capabilities/service');
const { createStudioHttp } = require('../companion/http/studio-http');
const { createPhotoshopMcp } = require('../companion/photoshop-mcp.cjs');
const { DomainError } = require('../companion/domain/contracts');
const { context: fixtureContext } = require('../companion/domain/fixtures');
const encode = require('../plugin/ps-encode-014');

const TOKEN = 'review-fixture-tool-token';
const PNG = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(107), 3));
const feedback = () => ({ items: [{ area: '左侧发丝边缘', category: 'artifact', description: '边缘存在光晕', requestedChange: '减弱光晕，保留细发丝' }], preserve: ['保留当前肤色'] });
const message = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const fixedExecution = job => ({ source: job.source, snapshot: job.snapshot, status: job.status, results: job.results, placement: job.placement, provider: job.provider });

async function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-review-transport-')), calls = [], services = [];
  const assets = createAssetStore({ rootDir: path.join(rootDir, 'assets') });
  const jobs = createJobStore({ rootDir: path.join(rootDir, 'jobs') });
  const forbidden = name => () => { calls.push(name); throw new Error('Review cannot dispatch ' + name); };
  const provider = { describe: forbidden('provider.describe'), generate: forbidden('provider.generate') };
  const bridge = { status: forbidden('bridge.status'), request: forbidden('bridge.request') };
  async function reopen() {
    const store = createJobStore({ rootDir: path.join(rootDir, 'jobs') });
    const service = createCapabilityService({ assets, jobs: store, provider, bridge });
    services.push(service); await service.ready; return { jobs: store, service };
  }
  const service = createCapabilityService({ assets, jobs, provider, bridge });
  services.push(service); await service.ready;
  t.after(async () => { for (const current of services) await current.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const context = structuredClone(fixtureContext), source = { documentRef: context.documentRef, scope: context.scope, transform: context.transform };
  context.baseAssetId = (await assets.put({ data: PNG, mimeType: 'image/png', purpose: 'input', source })).assetId;
  context.selectionMaskAssetId = (await assets.put({ data: PNG, mimeType: 'image/png', purpose: 'mask', source })).assetId;
  context.settings.autoApply = true;
  async function completeDraft(draft, label, status = 'succeeded') {
    const created = jobs.createJob({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: label });
    jobs.transition(created.job.jobId, 'running');
    if (status !== 'succeeded') jobs.transition(created.job.jobId, status);
    for (const index of [1, 2]) {
      const asset = await assets.put({ data: PNG, mimeType: 'image/png', purpose: 'result', source: { jobId: created.job.jobId } });
      jobs.addResults(created.job.jobId, [{ resultId: label + '-candidate-' + index, assetId: asset.assetId }]);
    }
    if (status === 'succeeded') jobs.transition(created.job.jobId, status);
    return jobs.getJob(created.job.jobId);
  }
  async function makeJob(label, status) {
    const draft = jobs.createDraft({ capabilityId: 'image.edit', params: { prompt: 'Preserve the person', model: 'fixture-model' }, context });
    return completeDraft(draft, label, status);
  }
  return { rootDir, jobs, service, calls, context, makeJob, completeDraft, reopen, stored: () => fs.readFileSync(path.join(rootDir, 'jobs', 'state.json')) };
}
async function transport(t, service) {
  const adapter = createStudioHttp({ service, toolToken: TOKEN });
  const server = http.createServer(async (req, res) => { if (!await adapter.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const mcp = createPhotoshopMcp({ base, token: TOKEN }); let sequence = 0;
  async function ui(operation, args = {}) {
    const response = await fetch(base + '/studio/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pxdls-agent': '1' }, body: JSON.stringify({ operation, arguments: args }) });
    return { status: response.status, ...await response.json() };
  }
  const tool = async (name, args = {}) => (await mcp.handle(message(name, args, ++sequence))).result;
  return { base, ui, tool };
}

test('HTTP and MCP share review revisions while feedback, acceptance and immutable execution remain independent', async t => {
  const f = await fixture(t), job = await f.makeJob('shared'), wire = await transport(t, f.service), before = f.stored();
  const empty = (await wire.tool('studio_get_job_review', { jobId: job.jobId })).structuredContent;
  assert.deepEqual(empty, { jobId: job.jobId, review: { revision: 0, feedback: [], acceptance: null }, previousAccepted: null });
  assert.deepEqual(f.stored(), before, 'reading an unwritten review does not invent a stored record');
  const input = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 0, requestId: 'shared-feedback', feedback: feedback(), source: 'system' };
  const first = (await wire.ui('updateResultFeedback', input)).value;
  assert.equal(first.review.revision, 1); assert.equal(first.review.feedback[0].recordedVia, 'ui');
  assert.equal(first.review.acceptance, null);
  const agent = (await wire.tool('studio_update_result_feedback', { ...input, expectedReviewRevision: 1, requestId: 'agent-analysis', source: 'ui', feedback: { items: [{ category: 'detail', description: '检查保留的发丝' }], preserve: ['保留肤色'] } })).structuredContent;
  assert.equal(agent.review.revision, 2); assert.equal(agent.review.feedback[0].recordedVia, 'agent'); assert.equal(agent.review.acceptance, null);
  const acceptInput = { jobId: job.jobId, resultId: job.results[1].resultId, expectedReviewRevision: 2, requestId: 'shared-choice', source: 'agent' };
  const accepted = (await wire.ui('setAcceptedResult', acceptInput)).value;
  assert.equal(accepted.review.revision, 3); assert.equal(accepted.review.acceptance.recordedVia, 'ui');
  const stale = await wire.tool('studio_update_result_feedback', { ...input, requestId: 'stale-analysis' });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'REVIEW_REVISION_CONFLICT');
  assert.deepEqual(stale.structuredContent.error.details.current, accepted.review);
  const retry = (await wire.tool('studio_update_result_feedback', { ...input, source: 'agent' })).structuredContent;
  assert.equal(retry.duplicate, true); assert.equal(retry.appliedRevision, 1); assert.deepEqual(retry.review, accepted.review);
  const changedChoice = (await wire.tool('studio_set_accepted_result', { ...acceptInput, expectedReviewRevision: 3, requestId: 'explicit-next-choice', resultId: job.results[0].resultId, source: 'ui' })).structuredContent;
  assert.equal(changedChoice.review.acceptance.recordedVia, 'agent');
  const oldChoice = (await wire.ui('setAcceptedResult', acceptInput)).value;
  assert.equal(oldChoice.duplicate, true); assert.equal(oldChoice.appliedRevision, 3); assert.deepEqual(oldChoice.review, changedChoice.review);
  const editedFeedback = (await wire.ui('updateResultFeedback', { ...input, expectedReviewRevision: 4, requestId: 'ui-final-analysis' })).value;
  assert.equal(editedFeedback.review.feedback[0].recordedVia, 'ui'); assert.deepEqual(editedFeedback.review.acceptance, changedChoice.review.acceptance);
  assert.equal((await wire.ui('getJobReview', { jobId: job.jobId })).value.review.revision, 5);
  const httpJob = (await wire.ui('getJob', { jobId: job.jobId })).value;
  assert.deepEqual(httpJob, (await wire.tool('studio_get_job', { jobId: job.jobId })).structuredContent);
  assert.deepEqual((await wire.ui('listJobs')).value, JSON.parse((await wire.tool('studio_list_jobs')).content[0].text));
  assert.deepEqual(fixedExecution(httpJob), fixedExecution(job));
  assert.equal(Object.hasOwn(httpJob, 'reviewRequests'), false); assert.equal(Object.hasOwn(editedFeedback, 'reviewRequests'), false);
  assert.deepEqual(f.calls, []);
});

test('late cancelled candidates can be reviewed and cleared while descendants read earlier accepted versions without inheritance', async t => {
  const f = await fixture(t), parent = await f.makeJob('parent'), wire = await transport(t, f.service);
  const parentAcceptance = (await wire.ui('setAcceptedResult', { jobId: parent.jobId, resultId: parent.results[0].resultId, expectedReviewRevision: 0, requestId: 'parent-choice' })).value;
  const draft = await f.service.deriveDraft({ jobId: parent.jobId, mode: 'original' });
  const child = await f.completeDraft(draft, 'cancelled-child', 'cancelled');
  const review = (await wire.tool('studio_get_job_review', { jobId: child.jobId })).structuredContent;
  assert.deepEqual(review.review, { revision: 0, feedback: [], acceptance: null });
  assert.deepEqual(review.previousAccepted, { jobId: parent.jobId, resultId: parent.results[0].resultId, reviewRevision: 1, recordedVia: 'ui', updatedAt: parentAcceptance.review.acceptance.updatedAt });
  assert.equal(Object.hasOwn((await wire.ui('getJob', { jobId: child.jobId })).value, 'review'), false);
  await wire.tool('studio_update_result_feedback', { jobId: child.jobId, resultId: child.results[0].resultId, expectedReviewRevision: 0, requestId: 'late-feedback', feedback: feedback() });
  const childChoice = (await wire.tool('studio_set_accepted_result', { jobId: child.jobId, resultId: child.results[0].resultId, expectedReviewRevision: 1, requestId: 'late-choice' })).structuredContent;
  assert.equal(childChoice.review.revision, 2);
  const grandDraft = await f.service.deriveDraft({ jobId: child.jobId, mode: 'original' });
  const grandchild = await f.completeDraft(grandDraft, 'grandchild', 'failed');
  assert.equal((await wire.ui('getJobReview', { jobId: grandchild.jobId })).value.previousAccepted.jobId, child.jobId);
  const cleared = (await wire.ui('setAcceptedResult', { jobId: child.jobId, resultId: null, expectedReviewRevision: 2, requestId: 'clear-late-choice' })).value;
  assert.equal(cleared.review.acceptance.resultId, null); assert.equal(cleared.review.acceptance.recordedVia, 'ui');
  assert.equal((await wire.tool('studio_get_job_review', { jobId: grandchild.jobId })).structuredContent.previousAccepted.jobId, parent.jobId);
  const removed = (await wire.ui('updateResultFeedback', { jobId: child.jobId, resultId: child.results[0].resultId, expectedReviewRevision: 3, requestId: 'remove-feedback', feedback: null })).value;
  assert.deepEqual(removed.review.feedback, []); assert.deepEqual(removed.review.acceptance, cleared.review.acceptance);
  for (const original of [parent, child, grandchild]) assert.deepEqual(fixedExecution(f.jobs.getJob(original.jobId)), fixedExecution(original));
  assert.deepEqual(f.jobs.getJob(child.jobId).snapshot.lineage, { sourceJobId: parent.jobId, mode: 'original' });
  assert.deepEqual(f.calls, []);
});

test('review boundaries reject spoofed attribution, unsafe revisions, malformed feedback and foreign candidates before writing', async t => {
  const f = await fixture(t), job = await f.makeJob('valid'), other = await f.makeJob('foreign'), wire = await transport(t, f.service);
  const before = f.stored(), valid = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 0, requestId: 'bad-input', feedback: feedback() };
  const oversized = { items: Array.from({ length: 20 }, () => ({ category: 'detail', description: '界'.repeat(1100) })), preserve: [] };
  for (const patch of [
    { recordedVia: 'ui' }, { approved: true }, { expectedReviewRevision: -1 }, { expectedReviewRevision: 0.5 }, { expectedReviewRevision: Number.MAX_SAFE_INTEGER + 1 },
    { feedback: { items: [] } }, { feedback: { items: [], preserve: [], recordedVia: 'ui' } },
    { feedback: { items: [{ category: 'unknown', description: 'x' }], preserve: [] } },
    { feedback: { items: [{ category: 'detail', description: '' }], preserve: [] } },
    { feedback: { items: [{ category: 'detail', description: 'x', approved: true }], preserve: [] } }, { feedback: oversized },
  ]) {
    const httpResult = await wire.ui('updateResultFeedback', { ...valid, ...patch });
    assert.equal(httpResult.status, 400); assert.equal(httpResult.error.code, 'INVALID_INPUT');
    assert.equal((await wire.tool('studio_update_result_feedback', { ...valid, ...patch })).structuredContent.error.code, 'INVALID_INPUT');
  }
  const choice = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 0, requestId: 'bad-choice' };
  for (const patch of [{ recordedVia: 'ui' }, { approvedBy: 'human' }, { resultId: undefined }, { expectedReviewRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await wire.ui('setAcceptedResult', { ...choice, ...patch })).error.code, 'INVALID_INPUT');
    assert.equal((await wire.tool('studio_set_accepted_result', { ...choice, ...patch })).structuredContent.error.code, 'INVALID_INPUT');
  }
  assert.equal((await wire.ui('updateResultFeedback', { ...valid, resultId: other.results[0].resultId })).error.code, 'RESULT_NOT_FOUND');
  assert.equal((await wire.tool('studio_set_accepted_result', { ...choice, resultId: other.results[0].resultId })).structuredContent.error.code, 'RESULT_NOT_FOUND');
  assert.equal((await wire.tool('studio_get_job_review', { jobId: 'missing-job' })).structuredContent.error.code, 'JOB_NOT_FOUND');
  assert.deepEqual(f.stored(), before); assert.deepEqual(f.calls, []);
});

test('a lost MCP write reply can be reconciled through HTTP after restart without replacing a later choice', async t => {
  const f = await fixture(t), job = await f.makeJob('lost-reply'), wire = await transport(t, f.service);
  let requests = 0;
  const mcp = createPhotoshopMcp({ base: wire.base, token: TOKEN, fetchImpl: async (...args) => {
    requests++; const response = await fetch(...args); assert.equal(response.status, 200); await response.arrayBuffer();
    throw new Error('fixture-private-transport-details');
  } });
  const input = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 0, requestId: 'lost-feedback', feedback: feedback() };
  const failed = (await mcp.handle(message('studio_update_result_feedback', input))).result;
  assert.equal(failed.structuredContent.error.code, 'TRANSPORT_UNCERTAIN'); assert.equal(requests, 1);
  assert.ok(!JSON.stringify(failed).includes('fixture-private-transport-details'));
  const saved = (await wire.ui('getJobReview', { jobId: job.jobId })).value;
  assert.equal(saved.review.revision, 1); assert.equal(saved.review.feedback[0].recordedVia, 'agent');
  const later = (await wire.ui('setAcceptedResult', { jobId: job.jobId, resultId: job.results[1].resultId, expectedReviewRevision: 1, requestId: 'after-lost-reply' })).value;
  await f.service.close(); const reopened = await f.reopen(), restarted = await transport(t, reopened.service);
  const retry = (await restarted.ui('updateResultFeedback', input)).value;
  assert.equal(retry.duplicate, true); assert.equal(retry.appliedRevision, 1); assert.deepEqual(retry.review, later.review);
  assert.equal(retry.review.feedback[0].recordedVia, 'agent');
  const conflict = await restarted.ui('updateResultFeedback', { ...input, feedback: { items: [], preserve: [] } });
  assert.equal(conflict.status, 409); assert.equal(conflict.error.code, 'REQUEST_CONFLICT');
  assert.deepEqual(fixedExecution(reopened.jobs.getJob(job.jobId)), fixedExecution(job)); assert.deepEqual(f.calls, []);
});

test('review service freezes the request before awaits, reports uncertain persistence safely and prevents writes after close', async t => {
  const f = await fixture(t), job = await f.makeJob('service');
  const input = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 0, requestId: 'frozen', feedback: feedback(), source: 'agent' };
  const pending = f.service.updateResultFeedback(input);
  input.feedback.items[0].description = 'changed after call'; input.source = 'system'; input.resultId = job.results[1].resultId;
  const saved = await pending;
  assert.equal(saved.review.feedback[0].items[0].description, feedback().items[0].description);
  assert.equal(saved.review.feedback[0].resultId, job.results[0].resultId); assert.equal(saved.review.feedback[0].recordedVia, 'agent');
  const original = f.jobs.setAcceptedResult;
  f.jobs.setAcceptedResult = value => { original(value); throw new DomainError('STORAGE_UNAVAILABLE', 'fixture-private-storage-details', 503); };
  const choice = { jobId: job.jobId, resultId: job.results[0].resultId, expectedReviewRevision: 1, requestId: 'published-choice' };
  await assert.rejects(f.service.setAcceptedResult(choice), error => error.code === 'STORAGE_UNAVAILABLE' && /could not be confirmed/.test(error.message) && !error.message.includes('fixture-private'));
  f.jobs.setAcceptedResult = original;
  const reconciled = await f.service.setAcceptedResult(choice);
  assert.equal(reconciled.duplicate, true); assert.equal(reconciled.appliedRevision, 2);
  await f.service.close(); const before = f.stored();
  await assert.rejects(f.service.setAcceptedResult({ ...choice, expectedReviewRevision: 2, requestId: 'after-close' }), { code: 'SERVICE_CLOSING' });
  assert.equal((await f.service.getJobReview(job.jobId)).review.revision, 2);
  assert.deepEqual(f.stored(), before); assert.deepEqual(f.calls, []);
});

test('MCP distinguishes an unread review from an unconfirmed review write and does not retry either', async () => {
  let calls = 0;
  const broken = createPhotoshopMcp({ token: TOKEN, fetchImpl: async () => { calls++; throw new Error('fixture-private-network-details'); } });
  const read = (await broken.handle(message('studio_get_job_review', { jobId: 'job-fixture' }))).result;
  assert.equal(read.structuredContent.error.code, 'TRANSPORT_UNAVAILABLE');
  assert.doesNotMatch(read.structuredContent.error.message, /requestId|save is unconfirmed/);
  const args = { jobId: 'job-fixture', resultId: null, expectedReviewRevision: 0, requestId: 'choice-fixture' };
  const write = (await broken.handle(message('studio_set_accepted_result', args))).result;
  assert.equal(write.structuredContent.error.code, 'TRANSPORT_UNCERTAIN'); assert.equal(calls, 2);
  assert.ok(!JSON.stringify([read, write]).includes('fixture-private-network-details'));
  for (const body of ['{invalid', JSON.stringify({ ok: true }), JSON.stringify({ ok: false })]) {
    const malformed = createPhotoshopMcp({ token: TOKEN, fetchImpl: async () => new Response(body) });
    assert.equal((await malformed.handle(message('studio_set_accepted_result', args))).result.structuredContent.error.code, 'TRANSPORT_UNCERTAIN');
  }
});

test('MCP treats malformed or mismatched review acknowledgements as unconfirmed instead of successful saves', async () => {
  const now = '2026-10-04T04:00:00.000Z';
  const args = { jobId: 'job-fixture', resultId: 'result-fixture', expectedReviewRevision: 0, requestId: 'ack-fixture' };
  const valid = { jobId: args.jobId, review: { revision: 1, feedback: [], acceptance: { resultId: args.resultId, recordedVia: 'agent', updatedAt: now }, updatedAt: now }, appliedRevision: 1, duplicate: false };
  const invalid = [null, {}, { ...valid, jobId: 'foreign-job' }, { ...valid, duplicate: 'false' }, { ...valid, duplicate: undefined }, { ...valid, appliedRevision: 99 }, { ...valid, appliedRevision: 0 }, { ...valid, appliedRevision: Number.MAX_SAFE_INTEGER + 1 }];
  for (const patch of [{ revision: 0 }, { revision: 2 }, { revision: 0.5 }, { feedback: null }, { acceptance: null }, { acceptance: { ...valid.review.acceptance, resultId: 'foreign-result' } }, { acceptance: { ...valid.review.acceptance, recordedVia: 'ui' } }, { updatedAt: 'invalid' }]) invalid.push({ ...valid, review: { ...valid.review, ...patch } });
  for (const value of invalid) {
    let calls = 0;
    const mcp = createPhotoshopMcp({ token: TOKEN, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ ok: true, value })); } });
    const result = (await mcp.handle(message('studio_set_accepted_result', args))).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'TRANSPORT_UNCERTAIN'); assert.equal(calls, 1);
  }
  const feedbackArgs = { ...args, feedback: feedback() };
  const validFeedback = { ...valid, review: { ...valid.review, feedback: [{ resultId: args.resultId, ...feedback(), recordedVia: 'agent', updatedAt: now }], acceptance: null } };
  const changed = { ...validFeedback, review: { ...validFeedback.review, feedback: [{ ...validFeedback.review.feedback[0], items: [] }] } };
  const wrongFeedback = createPhotoshopMcp({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: true, value: changed })) });
  assert.equal((await wrongFeedback.handle(message('studio_update_result_feedback', feedbackArgs))).result.structuredContent.error.code, 'TRANSPORT_UNCERTAIN');
  for (const [name, input, value] of [
    ['studio_set_accepted_result', args, valid],
    ['studio_update_result_feedback', feedbackArgs, validFeedback],
    ['studio_set_accepted_result', args, { ...valid, duplicate: true, review: { ...valid.review, revision: 2, acceptance: { ...valid.review.acceptance, resultId: null, recordedVia: 'ui' } } }],
  ]) {
    const mcp = createPhotoshopMcp({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: true, value })) });
    assert.equal((await mcp.handle(message(name, input))).result.isError, false);
  }
});
