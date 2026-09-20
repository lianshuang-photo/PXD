const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createProviderSettings } = require('../companion/providers/settings');
const { createGeminiProvider } = require('../companion/providers');
const { createStudioHttp } = require('../companion/http/studio-http');
const { createCapabilityService } = require('../companion/capabilities/service');
const { createAssetStore } = require('../companion/assets');
const { createJobStore } = require('../companion/jobs');
const { context } = require('../companion/domain/fixtures');
const encode = require('../plugin/ps-encode-014');
const KEY = 'fixture-private-key-A-91837', NEXT_KEY = 'fixture-private-key-B-48219';
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-provider-settings-')), rootDir = path.join(root, 'private');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const factory = () => createProviderSettings({ rootDir, env: {}, ...options });
  return { root, rootDir, file: path.join(rootDir, 'gemini.json'), settings: factory(), restart: factory };
}
function noSecrets(value) { const text = JSON.stringify(value); assert.ok(!text.includes(KEY)); assert.ok(!text.includes(NEXT_KEY)); }

test('private BYOK state persists with revisions, never returns a key and clears it explicitly', t => {
  let calls = 0; const f = setup(t, { fetchImpl: () => { calls++; throw Error('No network expected'); } });
  assert.equal(f.settings.read().revision, 0);
  const preview = f.settings.update({ expectedRevision: 0, model: 'gemini-3-pro-image-preview', baseUrl: 'https://fixture.example/api', timeoutMs: 2000 });
  assert.equal(preview.configured, false); assert.equal(preview.provider.model, 'gemini-3-pro-image-preview'); assert.equal(preview.provider.limits.inputImages, 14);
  const stored = f.settings.update({ expectedRevision: 1, apiKey: KEY });
  assert.equal(stored.configured, true); assert.equal(stored.hasLocalApiKey, true); assert.equal(stored.baseUrl, 'https://fixture.example/api/v1beta'); noSecrets(stored);
  assert.deepEqual(f.restart().read(), stored);
  assert.throws(() => f.settings.update({ expectedRevision: 1, apiKey: NEXT_KEY }), { code: 'CONFIG_REVISION_CONFLICT' });
  assert.throws(() => f.settings.update({ expectedRevision: 2, apiKey: '' }), { code: 'INVALID_INPUT' });
  const kept = f.settings.update({ expectedRevision: 2, timeoutMs: 3000 }); assert.equal(kept.hasApiKey, true); noSecrets(kept);
  const cleared = f.settings.update({ expectedRevision: 3, clearApiKey: true });
  assert.equal(cleared.hasApiKey, false); assert.equal(cleared.configured, false); assert.ok(!fs.readFileSync(f.file, 'utf8').includes(KEY));
  if (process.platform !== 'win32') { assert.equal(fs.statSync(f.rootDir).mode & 0o777, 0o700); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600); }
  assert.equal(calls, 0);
});

test('environment overrides each field explicitly, including an empty key; invalid values are never echoed', t => {
  const env = {}, f = setup(t, { env });
  f.settings.update({ expectedRevision: 0, apiKey: KEY, model: 'gemini-3-pro-image-preview' });
  env.PXDLS_GEMINI_API_KEY = NEXT_KEY; env.PXDLS_GEMINI_BASE_URL = 'https://environment.example';
  const state = f.settings.read(); assert.equal(state.sources.apiKey, 'environment'); assert.equal(state.sources.model, 'local'); assert.equal(state.baseUrl, 'https://environment.example/v1beta'); noSecrets(state);
  assert.throws(() => f.settings.update({ expectedRevision: 1, apiKey: KEY }), { code: 'CONFIG_OVERRIDDEN' });
  assert.throws(() => f.settings.update({ expectedRevision: 1, baseUrl: 'https://local.example' }), { code: 'CONFIG_OVERRIDDEN' });
  const cleared = f.settings.update({ expectedRevision: 1, clearApiKey: true }); assert.equal(cleared.hasLocalApiKey, false); assert.equal(cleared.hasApiKey, true);
  env.PXDLS_GEMINI_API_KEY = ''; assert.equal(f.settings.read().configured, false);
  env.PXDLS_GEMINI_BASE_URL = 'https://unsafe.example?key=' + KEY;
  const invalid = f.settings.read(); assert.equal(invalid.configured, false); assert.equal(invalid.baseUrl, ''); noSecrets(invalid);
});

test('invalid updates and atomic publication failure preserve the previously saved secret', t => {
  const f = setup(t); f.settings.update({ expectedRevision: 0, apiKey: KEY }); const original = fs.readFileSync(f.file, 'utf8');
  for (const patch of [{ baseUrl: 'http://example.test' }, { baseUrl: 'https://example.test?token=' + KEY }, { model: KEY }, { apiKey: KEY + '\ninvalid' }, { timeoutMs: 0 }, { surprise: KEY }]) {
    assert.throws(() => f.settings.update({ expectedRevision: 1, ...patch }), error => { noSecrets({ message: error.message, details: error.details }); return true; });
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  }
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Error('synthetic disk failure ' + NEXT_KEY); };
    assert.throws(() => f.settings.update({ expectedRevision: 1, apiKey: NEXT_KEY }), error => { assert.equal(error.code, 'CONFIG_STORAGE_UNAVAILABLE'); noSecrets(error.message); return true; });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), original); assert.deepEqual(fs.readdirSync(f.rootDir), ['gemini.json']);
});

test('corrupt, linked and oversized configuration files fail closed without replacing their contents', t => {
  const f = setup(t); f.settings.update({ expectedRevision: 0, apiKey: KEY });
  const link = path.join(f.root, 'linked.json'); fs.linkSync(f.file, link);
  assert.throws(() => f.settings.read(), { code: 'CONFIG_STORAGE_CORRUPT' }); fs.unlinkSync(link);
  if (process.platform !== 'win32') {
    fs.renameSync(f.file, link); fs.symlinkSync(link, f.file);
    assert.throws(() => f.settings.read(), { code: 'CONFIG_STORAGE_CORRUPT' }); fs.unlinkSync(f.file); fs.renameSync(link, f.file);
  }
  fs.writeFileSync(f.file, 'broken ' + KEY);
  assert.throws(() => f.settings.update({ expectedRevision: 1, apiKey: NEXT_KEY }), { code: 'CONFIG_STORAGE_CORRUPT' }); assert.equal(fs.readFileSync(f.file, 'utf8'), 'broken ' + KEY);
  fs.writeFileSync(f.file, ' '.repeat(16385)); assert.throws(() => f.settings.read(), { code: 'CONFIG_STORAGE_CORRUPT' });
});

test('UI-only settings route shares loopback/origin/marker checks, bounds input and never exposes keys', async t => {
  const f = setup(t), transport = createStudioHttp({ service: {}, providerSettings: f.settings, toolToken: 'fixture-token' });
  const server = http.createServer((req, res) => transport.handle(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (input, headers = {}, route = '/studio/provider-settings') => {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { 'x-pxdls-agent': '1', 'content-type': 'application/json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); noSecrets(body); return { status: response.status, body };
  };
  assert.equal((await request(undefined, { 'x-pxdls-agent': '' })).status, 403);
  assert.equal((await request(undefined, { origin: 'https://remote.example' })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(base + '/studio/provider-settings', { headers: { host: 'remote.example', 'x-pxdls-agent': '1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await request(undefined, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(undefined, { origin: 'uxp://plugin' })).status, 200);
  const saved = await request({ expectedRevision: 0, apiKey: KEY }, { origin: base }); assert.equal(saved.status, 200); assert.equal(saved.body.value.hasApiKey, true);
  assert.equal((await request({ expectedRevision: 0, apiKey: NEXT_KEY })).status, 409);
  assert.equal((await request({ expectedRevision: 1, apiKey: 'x'.repeat(20000) })).status, 413);
  assert.equal((await request({ expectedRevision: 1, apiKey: KEY }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request({ operation: 'providerSettings', arguments: {} }, { 'x-pxdls-tool': 'fixture-token' }, '/studio/mcp')).status, 404);
  assert.equal(f.settings.read().revision, 1);
});

test('capability profiles follow the selected model even without credentials and remain defensive', () => {
  const provider = createGeminiProvider({ env: {}, config: { model: 'gemini-3-pro-image-preview' } });
  assert.equal(provider.describe().configured, false); assert.equal(provider.describe().model, 'gemini-3-pro-image-preview');
  assert.equal(provider.describe({ model: 'gemini-2.5-flash-image' }).limits.inputImages, 3);
  assert.deepEqual(provider.describe({ model: 'gemini-2.5-flash-image' }).settings.imageSize, []);
  const unknown = provider.describe({ model: 'custom-image-model' }); assert.equal(unknown.knownModel, false); assert.deepEqual(unknown.settings.aspectRatio, ['auto']);
  const listed = provider.describe(); listed.models[0].limits.inputImages = 99; assert.equal(provider.describe().models[0].limits.inputImages, 3);
  assert.throws(() => provider.describe({ model: '../bad' }), { code: 'INVALID_INPUT' });
});

test('submitted jobs keep their original endpoint, key and default model when configuration changes before dispatch', async t => {
  const png = Buffer.from(encode.encodePNGFromRGB(2, 2, new Uint8Array(12).fill(84), 3)), requests = [];
  const f = setup(t, { fetchImpl: async (url, options) => {
    requests.push({ url, key: options.headers['x-goog-api-key'] });
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }));
  } });
  f.settings.update({ expectedRevision: 0, apiKey: KEY, baseUrl: 'https://first.example', model: 'gemini-2.5-flash-image' });
  const assets = createAssetStore({ rootDir: path.join(f.root, 'assets') }), jobs = createJobStore({ rootDir: path.join(f.root, 'jobs') });
  const bridge = { status: () => ({ connected: true }), request: async () => ({ ok: true, documentRef: context.documentRef, scope: 'document', transform: context.transform, image: { base64: png.toString('base64'), mimeType: 'image/png', width: 2, height: 2 } }) };
  const service = createCapabilityService({ assets, jobs, provider: f.settings, bridge });
  const captured = await service.capture({ documentId: context.documentRef.documentId, scope: 'document' });
  const draft = await service.createDraft({ capabilityId: 'image.edit', params: { prompt: 'Keep texture' }, context: captured });
  let release, entered; const read = assets.read, started = new Promise(resolve => { entered = resolve; });
  assets.read = async assetId => { entered(); await new Promise(resolve => { release = resolve; }); return read(assetId); };
  const first = await service.run({ draftId: draft.draftId, expectedRevision: 1, requestId: 'first' }); await started;
  f.settings.update({ expectedRevision: 1, apiKey: NEXT_KEY, baseUrl: 'https://second.example', model: 'gemini-3-pro-image-preview' });
  assets.read = read; release(); await service.waitForIdle();
  assert.deepEqual(requests[0], { url: 'https://first.example/v1beta/models/gemini-2.5-flash-image:generateContent', key: KEY });
  assert.equal((await service.getJob(first.job.jobId)).provider.model, 'gemini-2.5-flash-image');
  assert.equal((await service.run({ draftId: draft.draftId, expectedRevision: 1, requestId: 'first' })).duplicate, true);
  await service.run({ draftId: draft.draftId, expectedRevision: 1, requestId: 'second' }); await service.waitForIdle();
  assert.deepEqual(requests[1], { url: 'https://second.example/v1beta/models/gemini-3-pro-image-preview:generateContent', key: NEXT_KEY });
  const persisted = jobs.listJobs(); noSecrets(persisted); assert.ok(!JSON.stringify(persisted).includes('example'));
  fs.writeFileSync(f.file, 'damaged configuration');
  const recovered = await service.run({ draftId: draft.draftId, expectedRevision: 1, requestId: 'first' });
  assert.equal(recovered.duplicate, true); assert.equal(recovered.job.jobId, first.job.jobId);
  await assert.rejects(service.run({ draftId: draft.draftId, expectedRevision: 1, requestId: 'third' }), { code: 'CONFIG_STORAGE_CORRUPT' });
  await assert.rejects(service.run({ draftId: draft.draftId, expectedRevision: 2, requestId: 'first' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(jobs.listJobs().length, 2); assert.equal(requests.length, 2); await service.close();
});
