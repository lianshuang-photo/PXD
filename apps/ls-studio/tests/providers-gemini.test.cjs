'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGeminiProvider } = require('../companion/providers');
const { createAssetStore } = require('../companion/assets');
const { DomainError, publicError } = require('../companion/domain/contracts');

const KEY = 'fixture-key-do-not-persist';
const PROMPT = 'Preserve the face, clean stray hair, and match the reference colors.';
// Complete files: 1×1 RGB/grayscale PNGs, and Pillow-encoded 2×3 JPEG/WebP.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AH9/fwL+AX41ZMjJAAAAAElFTkSuQmCC', 'base64');
const MASK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAADUlEQVR4AQECAP3/AIAAggCBw24l4AAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkqKKK+7PXP//Z', 'base64');
const WEBP = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vD6K/9g7/9Kx/6Vj9kj/cFJ6GyMAAAA', 'base64');
function image(assetId, data = PNG, mimeType = 'image/png', role) {
  return { asset: { assetId, mimeType, width: 1, height: 1 }, data: Buffer.from(data), ...(role ? { role } : {}) };
}
function request({ selection = true, refs = ['identity'] } = {}) {
  const entries = refs.map((role, i) => image('ref-' + i, PNG, 'image/png', role));
  return {
    jobId: 'job-test', requestId: 'request-test', params: { prompt: PROMPT },
    context: {
      documentRef: { runtimeId: 'host-test', documentToken: 'document-test', documentId: 1, historyStateId: 4, width: 1, height: 1, name: 'private-document-name' },
      scope: selection ? 'selection' : 'document', baseAssetId: 'base-test',
      ...(selection ? { selectionMaskAssetId: 'mask-test' } : {}),
      refs: entries.map(entry => ({ assetId: entry.asset.assetId, role: entry.role })),
      preserve: ['face identity', 'costume details'],
      transform: { sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }, inputWidth: 1, inputHeight: 1 },
    },
    inputs: { base: image('base-test'), ...(selection ? { mask: image('mask-test', MASK) } : {}), refs: entries },
  };
}
function output(parts = [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }], extra = {}) {
  return { responseId: 'remote-request-123', candidates: [{ finishReason: 'STOP', content: { parts } }], ...extra };
}
function json(data, init = {}) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init }); }
function provider(fetchImpl = async () => json(output()), config = {}) {
  return createGeminiProvider({ env: {}, config: { apiKey: KEY, ...config }, fetchImpl });
}
function expectError(code, reason) {
  return error => {
    assert.equal(error.code, code);
    if (reason) assert.equal(error.details?.reason, reason);
    const serialized = JSON.stringify(publicError(error));
    assert.equal(serialized.includes(KEY), false);
    assert.equal(serialized.includes(PROMPT), false);
    assert.equal(serialized.includes('raw-provider-secret'), false);
    return true;
  };
}

test('configuration uses explicit BYOK variables only and discovery is redacted and defensive', async () => {
  let calls = 0;
  const disabled = createGeminiProvider({ env: { GOOGLE_API_KEY: KEY, GEMINI_API_KEY: KEY, CODEX_API_KEY: KEY }, fetchImpl: () => { calls++; } });
  assert.equal(disabled.describe().configured, false);
  await assert.rejects(disabled.generate(request()), expectError('PROVIDER_NOT_CONFIGURED'));
  assert.equal(calls, 0);
  const enabled = createGeminiProvider({ env: { PXDLS_GEMINI_API_KEY: KEY, PXDLS_GEMINI_BASE_URL: 'https://proxy.example.test/sensitive-route/v1beta', PXDLS_GEMINI_MODEL: 'models/gemini-3-pro-image-preview' } });
  const description = enabled.describe();
  assert.equal(description.configured, true);
  assert.equal(description.model, 'gemini-3-pro-image-preview');
  assert.deepEqual(description.settings.imageSize, ['1K', '2K', '4K']);
  assert.equal(JSON.stringify(description).includes(KEY), false);
  assert.equal(JSON.stringify(description).includes('sensitive-route'), false);
  description.settings.imageSize.push('8K'); description.limits.inputImages = 999;
  assert.deepEqual(enabled.describe().settings.imageSize, ['1K', '2K', '4K']);
  assert.equal(enabled.describe().limits.inputImages, 14);
  // process.env is a Node special object, not a plain object. Config must work with the default env.
  assert.equal(createGeminiProvider({ config: { apiKey: KEY, baseUrl: 'https://example.test', model: 'gemini-2.5-flash-image', timeoutMs: 1000 } }).describe().configured, true);
});

test('configuration rejects unsafe API roots and invalid models without exposing values', async () => {
  const configs = [
    { baseUrl: 'http://example.test' }, { baseUrl: 'https://user:raw-provider-secret@example.test' },
    { baseUrl: 'https://example.test?key=' + KEY }, { baseUrl: 'https://example.test/#raw-provider-secret' },
    { baseUrl: 'https://example.test/v1beta/models/model:generateContent' },
    { model: '../raw-provider-secret' }, { model: KEY }, { apiKey: KEY + '\nwrong' },
    { timeoutMs: 'not-a-number' }, { timeoutMs: 0 }, { timeoutMs: 600001 },
  ];
  for (const config of configs) {
    let calls = 0;
    const p = provider(() => { calls++; }, config);
    assert.equal(p.describe().configured, false);
    assert.equal(JSON.stringify(p.describe()).includes('raw-provider-secret'), false);
    assert.equal(JSON.stringify(p.describe()).includes(KEY), false);
    await assert.rejects(p.generate(request()), expectError('PROVIDER_NOT_CONFIGURED'));
    assert.equal(calls, 0);
  }
});

test('generateContent preserves prompt, grayscale mask, role references and constraints with no unrelated context', async () => {
  let calls = 0;
  const input = request();
  input.params.temperature = 0.4; input.params.aspectRatio = '4:5';
  const p = provider(async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    assert.equal(url.includes(KEY), false);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-goog-api-key'], KEY);
    assert.equal(options.signal instanceof AbortSignal, true);
    const body = JSON.parse(options.body);
    assert.equal(options.body.includes('private-document-name'), false);
    assert.equal(options.body.includes('host-test'), false);
    assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.4, imageConfig: { aspectRatio: '4:5' } });
    const parts = body.contents[0].parts;
    assert.equal(body.contents[0].role, 'user');
    assert.equal(parts.some(part => part.text?.includes(PROMPT)), true);
    assert.equal(parts.some(part => part.text?.includes('face identity') && part.text?.includes('costume details')), true);
    assert.equal(parts.some(part => part.text?.includes('EDIT_MASK') && part.text?.includes('black (0) is protected')), true);
    assert.equal(parts.some(part => part.text?.includes('role=identity') && part.text?.includes('ref-0')), true);
    assert.deepEqual(parts.filter(part => part.inlineData).map(part => part.inlineData.data), [PNG, MASK, PNG].map(bytes => bytes.toString('base64')));
    return json(output());
  });
  const result = await p.generate(input);
  assert.equal(calls, 1);
  assert.deepEqual(result.images, [{ data: PNG, mimeType: 'image/png' }]);
  assert.deepEqual(result.provider, { id: 'gemini', model: 'gemini-2.5-flash-image', requestId: 'remote-request-123' });
  assert.equal(JSON.stringify(result.provider).includes(KEY), false);
});

test('models use their own advertised settings and do not silently drop unsupported optional parameters', async () => {
  const bodies = [];
  const p = provider(async (url, options) => { bodies.push({ url, body: JSON.parse(options.body) }); return json(output()); });
  const unsupported = request(); unsupported.params.imageSize = '1K';
  await assert.rejects(p.generate(unsupported), expectError('INVALID_INPUT'));
  assert.equal(bodies.length, 0);
  const highRes = request({ refs: ['identity', 'style', 'structure', 'reference'] });
  highRes.params = { prompt: PROMPT, model: 'models/gemini-3-pro-image-preview', imageSize: '4K', aspectRatio: '16:9' };
  await p.generate(highRes);
  assert.equal(bodies[0].url.endsWith('/models/gemini-3-pro-image-preview:generateContent'), true);
  assert.deepEqual(bodies[0].body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '4K' });
  assert.equal(bodies[0].body.contents[0].parts.filter(part => part.inlineData).length, 6);
  const future = request(); future.params.model = 'future-image-model'; future.params.aspectRatio = '1:1';
  await assert.rejects(p.generate(future), expectError('INVALID_INPUT'));
  future.params.aspectRatio = 'auto';
  await p.generate(future);
  assert.equal(bodies[1].body.generationConfig.imageConfig, undefined);
  assert.equal(provider(undefined, { model: 'future-image-model' }).describe().knownModel, false);
});

test('base URLs preserve API version and proxy prefix without a duplicated v1beta', async () => {
  for (const [baseUrl, expected] of [
    ['https://proxy.example.test/gemini/', 'https://proxy.example.test/gemini/v1beta/models/'],
    ['https://proxy.example.test/gemini/v1beta/', 'https://proxy.example.test/gemini/v1beta/models/'],
    ['https://proxy.example.test/gemini/v1', 'https://proxy.example.test/gemini/v1/models/'],
  ]) {
    await provider(async url => { assert.equal(url.startsWith(expected), true); return json(output()); }, { baseUrl }).generate(request());
  }
});

test('source, mask, references, unknown parameters and bounded payload are validated before fetch', async () => {
  const cases = [
    value => { value.params.prompt = ' '; },
    value => { value.params.apiKey = KEY; },
    value => { value.params.temperature = 3; },
    value => { value.inputs.base.asset.assetId = 'different'; },
    value => { value.inputs.base.asset.width = 2; },
    value => { value.inputs.base.data = 'not-a-buffer'; },
    value => { value.inputs.base.data = Buffer.from('not an image'); },
    value => { value.inputs.base.asset.mimeType = 'image/jpeg'; },
    value => { value.inputs.base.asset.width = 1e9; },
    value => { delete value.inputs.mask; },
    value => { value.inputs.mask.asset.width = 2; },
    value => { value.inputs.mask.asset.assetId = 'different'; },
    value => { value.inputs.refs[0].role = 'style'; },
    value => { value.inputs.refs = []; },
    value => { value.inputs.base.data = Buffer.alloc(14 * 1024 * 1024 + 1); PNG.copy(value.inputs.base.data); },
    value => { value.inputs.base.data = Buffer.alloc(8 * 1024 * 1024); PNG.copy(value.inputs.base.data); value.inputs.mask.data = Buffer.alloc(8 * 1024 * 1024); PNG.copy(value.inputs.mask.data); },
  ];
  let calls = 0;
  const p = provider(() => { calls++; });
  for (const change of cases) {
    const value = request(); change(value);
    await assert.rejects(p.generate(value), error => ['INVALID_INPUT', 'PROMPT_REQUIRED'].includes(error.code));
  }
  await assert.rejects(p.generate(request({ refs: ['identity', 'style'] })), expectError('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('response accepts camel/snake aliases, multiple image MIME types and safe request ID fallback', async () => {
  const response = output([
    { text: 'done' },
    { thought: true, inlineData: { mimeType: 'image/png', data: 'invalid thought data' } },
    { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
    { inline_data: { mime_type: 'image/jpeg', data: JPEG.toString('base64').replace(/=+$/, '') } },
    { inline_data: { mimeType: 'image/webp', data: WEBP.toString('base64') + '\n' } },
  ], { responseId: KEY });
  const result = await provider(async () => json(response)).generate(request());
  assert.deepEqual(result.images.map(entry => entry.mimeType), ['image/png', 'image/jpeg', 'image/webp']);
  assert.deepEqual(result.images.map(entry => entry.data), [PNG, JPEG, WEBP]);
  assert.equal(result.provider.requestId, 'request-test');
  const snake = { response_id: 'snake-id', candidates: [{ finish_reason: 'STOP', content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG.toString('base64') } }] } }] };
  assert.equal((await provider(async () => json(snake)).generate(request())).provider.requestId, 'snake-id');
});

test('valid source, grayscale mask, references and returned images round-trip through the real asset store', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-provider-assets-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const assets = createAssetStore({ rootDir });
  const input = request();
  const source = { documentRef: input.context.documentRef, scope: input.context.scope, transform: input.context.transform };
  const putInput = (entry, purpose) => assets.read(assets.put({ data: entry.data, mimeType: entry.asset.mimeType, width: entry.asset.width, height: entry.asset.height, purpose, source }).assetId);
  input.inputs.base = putInput(input.inputs.base, 'input');
  input.inputs.mask = putInput(input.inputs.mask, 'mask');
  input.inputs.refs = input.inputs.refs.map(entry => ({ ...putInput(entry, 'reference'), role: entry.role }));
  input.context.baseAssetId = input.inputs.base.asset.assetId;
  input.context.selectionMaskAssetId = input.inputs.mask.asset.assetId;
  input.context.refs = input.inputs.refs.map(entry => ({ assetId: entry.asset.assetId, role: entry.role }));
  const fixtures = [[PNG, 'image/png', 1, 1], [JPEG, 'image/jpeg', 2, 3], [WEBP, 'image/webp', 2, 3]];
  const p = provider(async (_url, options) => {
    const transmitted = JSON.parse(options.body).contents[0].parts.filter(part => part.inlineData);
    assert.deepEqual(transmitted.map(part => Buffer.from(part.inlineData.data, 'base64')), [PNG, MASK, PNG]);
    return json(output(fixtures.map(([data, mimeType]) => ({ inlineData: { mimeType, data: data.toString('base64') } }))));
  });
  const result = await p.generate(input);
  const stored = result.images.map(entry => assets.put({ ...entry, purpose: 'result', source: { jobId: input.jobId, provider: result.provider } }));
  const restarted = createAssetStore({ rootDir });
  stored.forEach((asset, index) => {
    const [data, mimeType, width, height] = fixtures[index];
    const loaded = restarted.read(asset.assetId);
    assert.deepEqual(loaded.data, data);
    assert.deepEqual([loaded.asset.mimeType, loaded.asset.width, loaded.asset.height, loaded.asset.purpose], [mimeType, width, height, 'result']);
  });
});

test('HTTP failures are classified with exactly one attempt and no raw error body', async () => {
  for (const [status, code] of [[400, 'PROVIDER_REJECTED'], [401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [404, 'PROVIDER_REJECTED'], [408, 'PROVIDER_UNCERTAIN'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_UNCERTAIN'], [503, 'PROVIDER_UNCERTAIN']]) {
    let calls = 0;
    const p = provider(async () => { calls++; return new Response(KEY + PROMPT + 'raw-provider-secret', { status }); });
    await assert.rejects(p.generate(request()), expectError(code));
    assert.equal(calls, 1);
  }
});

test('success-status error envelopes and prompt/output blocks are not successful image results', async () => {
  const cases = [
    [{ error: { code: 403, message: KEY + PROMPT } }, 'PROVIDER_AUTH'],
    [{ error: { status: 'RESOURCE_EXHAUSTED', message: KEY } }, 'PROVIDER_RATE_LIMIT'],
    [{ error: { status: 'INVALID_ARGUMENT', message: KEY } }, 'PROVIDER_REJECTED'],
    [{ error: { status: 'UNAVAILABLE', message: KEY } }, 'PROVIDER_UNCERTAIN'],
    [output(undefined, { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: KEY } }), 'PROVIDER_REJECTED'],
    [output(undefined, { prompt_feedback: { block_reason: 'OTHER', block_reason_message: KEY } }), 'PROVIDER_REJECTED'],
    [{ candidates: [{ finishReason: 'SAFETY', finishMessage: KEY, content: { parts: output().candidates[0].content.parts } }] }, 'PROVIDER_REJECTED'],
    [{ candidates: [{ finishReason: 'IMAGE_PROHIBITED_CONTENT' }] }, 'PROVIDER_REJECTED'],
  ];
  for (const [data, code] of cases) await assert.rejects(provider(async () => json(data)).generate(request()), expectError(code));
});

test('invalid or incomplete images and text/URL fallback never create additional network requests', async () => {
  const cases = [
    null, {}, { candidates: [] }, { candidates: [null] },
    output([{ text: 'https://remote.example.test/' + KEY }]),
    output([{ text: 'data:image/png;base64,' + PNG.toString('base64') }]),
    output([{ inlineData: { mimeType: 'image/png', data: 'not-base64-!?' } }]),
    output([{ inlineData: { mimeType: 'image/png', data: Buffer.from('not PNG').toString('base64') } }]),
    output([{ inlineData: { mimeType: 'image/tiff', data: PNG.toString('base64') } }]),
    output([{ inlineData: { mimeType: 'image/jpeg', data: PNG.toString('base64') } }]),
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: output().candidates[0].content.parts } }] },
    output(Array.from({ length: 5 }, () => output().candidates[0].content.parts[0])),
  ];
  for (const value of cases) {
    let calls = 0;
    await assert.rejects(provider(async () => { calls++; return json(value); }).generate(request()), expectError('PROVIDER_UNCERTAIN'));
    assert.equal(calls, 1);
  }
  await assert.rejects(provider(async () => new Response('not-json ' + KEY)).generate(request()), expectError('PROVIDER_UNCERTAIN', 'INVALID_RESPONSE'));
});

test('image bytes without an explicit final STOP status are uncertain and never retried', async () => {
  for (const finishReason of [undefined, null, '', 'FINISH_REASON_UNSPECIFIED', 'MAX_TOKENS', 'OTHER']) {
    const data = output();
    if (finishReason === undefined) delete data.candidates[0].finishReason;
    else data.candidates[0].finishReason = finishReason;
    let calls = 0;
    await assert.rejects(provider(async () => { calls++; return json(data); }).generate(request()), expectError('PROVIDER_UNCERTAIN', 'NO_IMAGE'));
    assert.equal(calls, 1);
  }
});

test('response read is bounded by declared and actual bytes; streams are cancelled', async () => {
  const limit = provider().describe().limits.responseBytes;
  let cancelledDeclared = false;
  const tooLarge = new Response(new ReadableStream({ cancel() { cancelledDeclared = true; } }), { headers: { 'content-length': String(limit + 1) } });
  await assert.rejects(provider(async () => tooLarge).generate(request()), expectError('PROVIDER_UNCERTAIN', 'RESPONSE_TOO_LARGE'));
  assert.equal(cancelledDeclared, true);
  let cancelledStream = false;
  const chunk = new Uint8Array(1024 * 1024);
  const oversizedStream = new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); }, cancel() { cancelledStream = true; } }));
  await assert.rejects(provider(async () => oversizedStream).generate(request()), expectError('PROVIDER_UNCERTAIN', 'RESPONSE_TOO_LARGE'));
  assert.equal(cancelledStream, true);
  const noStream = { status: 200, headers: new Headers(), json() { throw new Error('Unbounded json must not be called'); } };
  await assert.rejects(provider(async () => noStream).generate(request()), expectError('PROVIDER_UNCERTAIN', 'RESPONSE_STREAM_REQUIRED'));
});

test('network error details, AbortError without caller cancellation and injected DomainError stay redacted', async () => {
  for (const error of [new Error(KEY + PROMPT + 'raw-provider-secret'), new DOMException(KEY, 'AbortError'), new DomainError('UNSAFE_EXTERNAL', KEY)]) {
    let calls = 0;
    const p = provider(async () => { calls++; throw error; });
    await assert.rejects(p.generate(request()), expectError('PROVIDER_UNCERTAIN', 'NETWORK_ERROR'));
    assert.equal(calls, 1);
  }
});

test('pre-aborted request never sends and active abort propagates while ignoring late completion', async () => {
  const before = new AbortController(); before.abort(KEY);
  let calls = 0;
  await assert.rejects(provider(() => { calls++; }).generate(request(), { signal: before.signal }), expectError('CANCELLED'));
  assert.equal(calls, 0);
  let receivedSignal, completeFetch;
  const controller = new AbortController();
  const active = provider((_url, options) => { calls++; receivedSignal = options.signal; return new Promise(resolve => { completeFetch = resolve; }); });
  const pending = active.generate(request(), { signal: controller.signal });
  controller.abort(KEY);
  await assert.rejects(pending, expectError('CANCELLED'));
  assert.equal(receivedSignal.aborted, true);
  let lateBodyCancelled = false;
  completeFetch(new Response(new ReadableStream({ cancel() { lateBodyCancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(lateBodyCancelled, true);
  await assert.rejects(active.generate(request(), { signal: null }), expectError('INVALID_INPUT'));
});

test('abort and timeout also stop a stalled response reader without leaked raw details', async () => {
  let reading, wasCancelled = false;
  const started = new Promise(resolve => { reading = resolve; });
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ pull() { reading(); return new Promise(() => {}); }, cancel() { wasCancelled = true; } }));
  const pending = provider(async () => response).generate(request(), { signal: controller.signal });
  await started; controller.abort(KEY);
  await assert.rejects(pending, expectError('CANCELLED'));
  assert.equal(wasCancelled, true);
  let timedSignal, calls = 0;
  const timeout = provider((_url, options) => { calls++; timedSignal = options.signal; return new Promise(() => {}); }, { timeoutMs: 15 });
  await assert.rejects(timeout.generate(request()), expectError('PROVIDER_UNCERTAIN', 'TIMEOUT'));
  assert.equal(timedSignal.aborted, true); assert.equal(calls, 1);
});
