const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { createCapabilityService } = require('../companion/capabilities/service');
const { DomainError, clone } = require('../companion/domain/contracts');
const { context } = require('../companion/domain/fixtures');
const encode = require('../plugin/ps-encode-014');
const png = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(127), 3));
// Valid compressed fixtures exercise the real asset store, not claimed dimensions.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function pngChunk(name, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(name, 4, 'ascii'); data.copy(out, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ crc >>> 8;
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function resultPng(width, height, { bitDepth = 8, colorType = 0, channels = 1, level = 6 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = bitDepth; header[9] = colorType;
  const pixels = Buffer.alloc((width * channels * bitDepth / 8 + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(pixels, { level })), pngChunk('IEND', Buffer.alloc(0))]);
}
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
  const provider = { describe: options.describe || (() => ({ id: 'fixture', configured: true })), generate: async (input, execution) => {
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
test('cancelled service output preserves its actual model in both revision modes without another execution', async t => {
  for (const actualModel of ['gemini-2.5-flash-image', undefined]) {
    let resolveResult, enteredResolve, executionSignal;
    const entered = new Promise(resolve => { enteredResolve = resolve; }), described = [];
    const f = await setup(t, {
      describe: ({ model } = {}) => { described.push(model); return { id: 'fixture', configured: true, model: model || 'gemini-3-pro-image-preview', limits: { inputImages: model === 'gemini-2.5-flash-image' ? 3 : 14, inputBytes: 14 * 1024 * 1024 } }; },
      generate: (_input, { signal }) => { executionSignal = signal; enteredResolve(); return new Promise(resolve => { resolveResult = resolve; }); },
    });
    const capture = clone(f.capture); capture.settings.autoApply = true;
    const { job } = await f.makeJob({ context: capture }); await entered;
    await f.service.cancel(job.jobId); assert.equal(executionSignal.aborted, true);
    resolveResult({ images: [{ data: png, mimeType: 'image/png' }], provider: { id: 'fixture', ...(actualModel ? { model: actualModel } : {}) } });
    await f.service.waitForIdle();
    const saved = await f.service.getJob(job.jobId), result = saved.results[0];
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.provider, undefined); assert.equal(saved.snapshot.params.model, undefined);
    assert.equal(result.provider.model, actualModel); assert.equal((await f.assets.read(result.assetId)).asset.source.provider.model, actualModel);
    const original = await f.service.deriveDraft({ jobId: job.jobId, mode: 'original' });
    assert.equal(original.params.model, actualModel); assert.deepEqual(original.context, saved.snapshot.context);
    if (actualModel) {
      const revision = await f.service.deriveDraft({ jobId: job.jobId, mode: 'candidate-reference', resultId: result.resultId });
      assert.equal(revision.params.model, actualModel);
      assert.deepEqual(revision.context, { ...saved.snapshot.context, refs: [{ assetId: result.assetId, role: 'reference' }] });
      assert.deepEqual(described, [actualModel]);
    } else {
      const count = f.jobs.listDrafts().length;
      await assert.rejects(f.service.deriveDraft({ jobId: job.jobId, mode: 'candidate-reference', resultId: result.resultId }), { code: 'REFERENCE_LIMIT_UNKNOWN' });
      assert.equal(f.jobs.listDrafts().length, count); assert.deepEqual(described, []);
    }
    assert.deepEqual(await f.service.getJob(job.jobId), saved); assert.equal(f.jobs.listJobs().length, 1);
    assert.equal(f.calls.filter(call => call.name === 'generate').length, 1); assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
  }
});
test('discovery publishes actual Photoshop placement limits without mutable shared arrays', async t => {
  const f = await setup(t), discovery = await f.service.discover();
  assert.deepEqual(discovery.limits.placement, { pixels: 8000000, imageBytes: 32 * 1024 * 1024, mimeTypes: ['image/png', 'image/jpeg'], returnTypes: ['new-layer'], groupResults: false });
  discovery.limits.placement.mimeTypes.push('image/webp');
  assert.deepEqual((await f.service.discover()).limits.placement.mimeTypes, ['image/png', 'image/jpeg']);
});
test('4K automatic placement fails before any provider request with actionable output guidance', async t => {
  const f = await setup(t), capture = clone(f.capture); capture.settings.autoApply = true;
  const { job } = await f.makeJob({ context: capture, params: { prompt: 'Fix hair', imageSize: '4K' } }); await f.service.waitForIdle();
  const result = await f.service.getJob(job.jobId);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'UNSUPPORTED_OUTPUT'); assert.match(result.error.message, /disable autoApply/);
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 0);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
test('unsupported result grouping is rejected before generation for automatic and later manual placement', async t => {
  const f = await setup(t);
  for (const autoApply of [false, true]) {
    const capture = clone(f.capture); capture.settings = { ...capture.settings, autoApply, groupResults: true };
    const { job } = await f.makeJob({ context: capture }); await f.service.waitForIdle();
    const result = await f.service.getJob(job.jobId);
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HOST_UNSUPPORTED'); assert.match(result.error.message, /disable groupResults/);
  }
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 0);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
test('4K generation without autoApply retains real output, while manual placement checks actual pixels', async t => {
  const data = resultPng(4096, 4096);
  const f = await setup(t, { generate: () => ({ images: [{ data, mimeType: 'image/png' }], provider: { id: 'fixture' } }) });
  const { job } = await f.makeJob({ params: { prompt: 'Generate a retained 4K image', imageSize: '4K' } }); await f.service.waitForIdle();
  const generated = await f.service.getJob(job.jobId), candidate = generated.results[0];
  assert.equal(generated.status, 'succeeded'); assert.equal(generated.placement.status, 'not-requested');
  assert.equal(f.calls.filter(call => call.name === 'generate').length, 1);
  assert.equal((await f.assets.get(candidate.assetId)).width, 4096);
  const placed = await f.service.apply({ jobId: job.jobId, resultId: candidate.resultId, requestId: 'oversized-pixel-output' });
  assert.equal(placed.status, 'succeeded'); assert.equal(placed.placement.status, 'failed'); assert.equal(placed.placement.error.code, 'UNSUPPORTED_OUTPUT'); assert.match(placed.placement.error.message, /8,000,000 pixels/);
  assert.deepEqual(placed.results, generated.results);
  assert.deepEqual((await f.service.readAsset(candidate.assetId)).data, data);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
test('unexpected WebP output remains readable and reports automatic placement failure without host dispatch', async t => {
  const data = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vD6K/9g7/9Kx/6Vj9kj/cFJ6GyMAAAA', 'base64');
  const f = await setup(t, { generate: () => ({ images: [{ data, mimeType: 'image/webp' }], provider: { id: 'fixture' } }) });
  const capture = clone(f.capture); capture.settings.autoApply = true;
  const { job } = await f.makeJob({ context: capture }); await f.service.waitForIdle();
  const result = await f.service.getJob(job.jobId);
  assert.equal(result.status, 'succeeded'); assert.equal(result.placement.status, 'failed'); assert.equal(result.placement.error.code, 'UNSUPPORTED_OUTPUT'); assert.match(result.placement.error.message, /PNG and JPEG/);
  assert.deepEqual((await f.service.readAsset(result.results[0].assetId)).data, data);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
test('placement rejects real encoded output over 32 MiB even when its pixel count is within limits', async t => {
  // Four million 16-bit RGBA pixels fit the host pixel limit but their stored
  // deflate stream is just over 32 MiB. The asset store allows retaining it.
  const data = resultPng(2048, 2048, { bitDepth: 16, colorType: 6, channels: 4, level: 0 });
  assert.ok(data.length > 32 * 1024 * 1024);
  const f = await setup(t, { generate: () => ({ images: [{ data, mimeType: 'image/png' }], provider: { id: 'fixture' } }) });
  const { job } = await f.makeJob(); await f.service.waitForIdle();
  const generated = await f.service.getJob(job.jobId), candidate = generated.results[0];
  assert.equal(generated.status, 'succeeded');
  const placed = await f.service.apply({ jobId: job.jobId, resultId: candidate.resultId, requestId: 'oversized-byte-output' });
  assert.equal(placed.placement.status, 'failed'); assert.equal(placed.placement.error.code, 'UNSUPPORTED_OUTPUT'); assert.match(placed.placement.error.message, /32 MiB/);
  assert.deepEqual((await f.service.readAsset(candidate.assetId)).data, data);
  assert.equal(f.calls.filter(call => call.name === 'studio_apply_result').length, 0);
});
