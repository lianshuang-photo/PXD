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
const { createTransport, createController } = require('../plugin/studio-014');
const settingsUi = require('../plugin/provider-settings-014');
const KEY = 'fixture-private-key-A-91837', NEXT_KEY = 'fixture-private-key-B-48219';
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-provider-settings-')), rootDir = path.join(root, 'private');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const factory = () => createProviderSettings({ rootDir, env: {}, ...options });
  return { root, rootDir, file: path.join(rootDir, 'gemini.json'), settings: factory(), restart: factory };
}
function noSecrets(value) { const text = JSON.stringify(value); assert.ok(!text.includes(KEY)); assert.ok(!text.includes(NEXT_KEY)); }

// Minimal DOM for settings text/state checks; it does not model UXP layout.
function formFixture(t, respond, onSaved) {
  function element(tag) {
    return { tagName: tag, children: [], value: '', textContent: '', disabled: false, attributes: {},
      classList: { add() {}, remove() {} }, addEventListener() {},
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter(value => value !== child); child.parentElement = null; },
    };
  }
  const requests = [], ui = {
    createButton(className, text) { const button = element('button'); button.className = className; button.textContent = text; return button; },
    setDisabled(button, value) { button.disabled = value; },
  };
  const transport = createTransport({ base: 'http://127.0.0.1:17881', fetchImpl: async (url, options) => {
    const request = { path: new URL(url).pathname, method: options.method, ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) };
    requests.push(request); return respond(request);
  } });
  const panel = settingsUi.mount({ document: { createElement: element }, parent: element('div'), ui, transport, onSaved });
  t.after(() => panel.dispose());
  return { panel, requests, visible: () => Object.values(panel.nodes).map(node => ({ text: node.textContent, value: node.value, placeholder: node.placeholder })) };
}
function formState(overrides = {}) {
  return { revision: 4, baseUrl: 'https://example.test/v1beta', model: 'gemini-2.5-flash-image', timeoutMs: 180000,
    sources: { baseUrl: 'default', model: 'default', timeoutMs: 'default', apiKey: 'local' }, hasApiKey: true, hasLocalApiKey: true, ...overrides };
}
const settingsResponse = value => Response.json({ ok: true, value });
const networkFailure = () => { throw new Error('transport failed with ' + KEY); };

test('provider form read failures explain local configuration access without submission or retry claims', async t => {
  for (const respond of [networkFailure, () => new Response('<invalid ' + KEY), () => settingsResponse(undefined), () => settingsResponse({ ...formState(), sources: undefined }), () => settingsResponse({ ...formState(), timeoutMs: null })]) {
    let refreshed = 0;
    const f = formFixture(t, respond, () => { refreshed++; });
    f.panel.nodes.providerApiKey.value = NEXT_KEY;
    await assert.rejects(f.panel.load());
    assert.match(f.panel.nodes.providerError.textContent, /本机服务/);
    assert.match(f.panel.nodes.providerError.textContent, /重新载入/);
    assert.doesNotMatch(f.panel.nodes.providerError.textContent, /提交结果|刷新任务|请求编号|自动重试|生成任务/);
    assert.equal(f.panel.nodes.providerNotice.textContent, ''); assert.equal(f.panel.nodes.providerApiKey.value, '');
    assert.equal(f.panel.nodes.providerSave.disabled, true); assert.equal(f.panel.nodes.providerReload.disabled, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.requests, [{ path: '/studio/provider-settings', method: 'GET' }]);
    assert.equal(refreshed, 0); noSecrets(f.visible());
  }
});

test('provider form uncertain saves and key deletion require an explicit reload and never resubmit', async t => {
  for (const action of ['save', 'clearKey']) {
    for (const fail of [networkFailure, () => new Response('<invalid ' + KEY), () => settingsResponse({ revision: 5 })]) {
      let state = formState(), refreshed = 0;
      const f = formFixture(t, request => {
        if (request.method === 'GET') return settingsResponse(state);
        // The write may have committed even though its response was lost/invalid.
        state = formState({ revision: 5, hasApiKey: action === 'save', hasLocalApiKey: action === 'save' });
        return fail();
      }, () => { refreshed++; });
      await f.panel.load(); f.panel.nodes.providerApiKey.value = NEXT_KEY;
      const pending = f.panel[action]();
      assert.equal(f.panel.nodes.providerApiKey.value, '');
      assert.equal(f.panel.nodes.providerNotice.textContent, action === 'save' ? '保存配置…' : '删除本地 Key…');
      await assert.rejects(pending);
      const message = f.panel.nodes.providerError.textContent;
      assert.match(message, action === 'save' ? /配置是否已保存尚未确认/ : /本地 Key 是否已删除尚未确认/);
      assert.match(message, /重新载入配置核对/); assert.doesNotMatch(message, /刷新任务|请求编号|自动重试|生成任务/);
      assert.equal(f.requests[1].body.expectedRevision, 4);
      if (action === 'save') assert.equal(f.requests[1].body.apiKey, NEXT_KEY);
      else assert.deepEqual(f.requests[1].body, { expectedRevision: 4, clearApiKey: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.requests.length, 2); assert.equal(refreshed, 0); noSecrets(f.visible());
      await f.panel.load(); assert.equal(f.panel.nodes.providerError.textContent, '');
      assert.equal(f.panel.nodes.providerClearKey.disabled, action === 'clearKey');
      assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.path === '/studio/provider-settings'));
      assert.equal(f.requests.filter(request => request.method === 'POST').length, 1); noSecrets(f.visible());
    }
  }
});

test('provider form revision conflicts preserve reload semantics and environment-owned fields stay locked', async t => {
  let state = formState({ sources: { baseUrl: 'environment', model: 'default', timeoutMs: 'environment', apiKey: 'environment' } });
  let writes = 0;
  const f = formFixture(t, request => {
    if (request.method === 'GET') return settingsResponse(state);
    writes++;
    if (writes === 1) { state = { ...state, revision: 5 }; return Response.json({ ok: false, error: { code: 'CONFIG_REVISION_CONFLICT', message: 'unsafe server text ' + KEY } }, { status: 409 }); }
    state = { ...state, revision: state.revision + 1, hasLocalApiKey: !request.body.clearApiKey };
    return settingsResponse(state);
  });
  await f.panel.load();
  for (const name of ['providerEndpoint', 'providerTimeout', 'providerApiKey']) assert.equal(f.panel.nodes[name].disabled, true);
  f.panel.nodes.providerApiKey.value = NEXT_KEY;
  await assert.rejects(f.panel.save(), { code: 'CONFIG_REVISION_CONFLICT' });
  assert.match(f.panel.nodes.providerError.textContent, /配置已被其他窗口修改.*重新载入/);
  assert.deepEqual(f.requests[1].body, { expectedRevision: 4, model: state.model }); noSecrets(f.visible());
  await f.panel.load(); await f.panel.clearKey();
  assert.deepEqual(f.requests.at(-1).body, { expectedRevision: 5, clearApiKey: true });
  assert.match(f.panel.nodes.providerNotice.textContent, /本地 Key 已删除.*仍使用环境变量/);
  assert.equal(f.panel.nodes.providerApiKey.disabled, true); assert.equal(f.panel.nodes.providerApiKey.value, '');
  assert.equal(f.panel.nodes.providerClearKey.disabled, true); noSecrets(f.visible());
});

test('provider form keeps confirmed writes distinct from a failed workspace refresh', async t => {
  for (const action of ['save', 'clearKey']) {
    const f = formFixture(t, request => settingsResponse(formState(request.method === 'POST' ? { revision: 5, hasLocalApiKey: action === 'save' } : {})), () => { throw Object.assign(new Error('private refresh text ' + NEXT_KEY), { code: 'NETWORK_ERROR' }); });
    await f.panel.load(); f.panel.nodes.providerApiKey.value = KEY;
    await assert.rejects(f.panel[action](), { code: 'NETWORK_ERROR' });
    assert.match(f.panel.nodes.providerError.textContent, action === 'save' ? /配置已保存，但工作区状态未刷新/ : /本地 Key 已删除，但工作区状态未刷新/);
    assert.doesNotMatch(f.panel.nodes.providerError.textContent, /尚未确认|请求编号|自动重试/);
    assert.equal(f.requests.length, 2); assert.equal(f.panel.nodes.providerApiKey.value, ''); noSecrets(f.visible());
  }
});

test('provider form never echoes raw configuration or service error messages containing credentials', async t => {
  const f = formFixture(t, request => request.method === 'GET'
    ? settingsResponse(formState({ configurationError: { code: 'PROVIDER_NOT_CONFIGURED', message: 'private configuration ' + KEY } }))
    : Response.json({ ok: false, error: { code: 'UNEXPECTED_SERVICE_FAILURE', message: 'private response ' + NEXT_KEY } }, { status: 500 }));
  await f.panel.load(); assert.match(f.panel.nodes.providerError.textContent, /配置未就绪/); noSecrets(f.visible());
  f.panel.nodes.providerApiKey.value = NEXT_KEY;
  await assert.rejects(f.panel.save(), { code: 'CONFIG_OPERATION_FAILED' });
  assert.match(f.panel.nodes.providerError.textContent, /重新载入配置核对/); noSecrets(f.visible());
  assert.equal(f.requests.length, 2);
});

test('provider form known pre-write rejections retain actionable classes on reads, saves and key deletion', async t => {
  for (const [errorCode, status, explanation, remedy] of [
    ['CONFIG_STORAGE_CORRUPT', 503, /配置文件无法读取或内容无效/, /文件内容和读取权限/],
    ['CAPABILITY_UNAVAILABLE', 503, /未提供图像服务设置功能/, /连接地址和服务版本/],
    ['BODY_TOO_LARGE', 413, /超过服务的大小限制/, /检查/],
  ]) {
    for (const action of ['load', 'save', 'clearKey']) {
      const f = formFixture(t, request => request.method === 'GET' && action !== 'load' ? settingsResponse(formState())
        : Response.json({ ok: false, error: { code: errorCode, message: 'private error ' + KEY, details: { apiKey: NEXT_KEY } } }, { status }));
      if (action !== 'load') await f.panel.load();
      f.panel.nodes.providerApiKey.value = NEXT_KEY;
      await assert.rejects(f.panel[action](), { code: errorCode });
      const message = f.panel.nodes.providerError.textContent;
      assert.match(message, explanation); assert.match(message, remedy); assert.match(message, /本次请求未修改配置/);
      assert.doesNotMatch(message, /尚未确认|刷新任务|请求编号|自动重试|已保存|已删除/);
      assert.equal(f.panel.nodes.providerApiKey.value, ''); assert.equal(f.panel.nodes.providerNotice.textContent, '');
      assert.equal(f.requests.length, action === 'load' ? 1 : 2);
      assert.equal(f.requests.at(-1).method, action === 'load' ? 'GET' : 'POST');
      assert.ok(f.requests.every(request => request.path === '/studio/provider-settings')); noSecrets(f.visible());
    }
  }
});

test('provider form read storage failures identify local storage without exposing raw diagnostics', async t => {
  const f = formFixture(t, () => Response.json({ ok: false, error: { code: 'CONFIG_STORAGE_UNAVAILABLE', message: 'cannot open ' + KEY } }, { status: 503 }));
  await assert.rejects(f.panel.load(), { code: 'CONFIG_STORAGE_UNAVAILABLE' });
  assert.match(f.panel.nodes.providerError.textContent, /配置存储暂时不可用.*目录权限或磁盘状态.*重新载入/);
  assert.doesNotMatch(f.panel.nodes.providerError.textContent, /保存|删除|尚未确认/);
  assert.deepEqual(f.requests, [{ path: '/studio/provider-settings', method: 'GET' }]); noSecrets(f.visible());
});

test('provider form storage failure after rename keeps save and deletion outcomes uncertain until reload', { skip: process.platform === 'win32' }, async t => {
  for (const action of ['save', 'clearKey']) {
    const storage = setup(t); storage.settings.update({ expectedRevision: 0, apiKey: KEY });
    const f = formFixture(t, request => {
      try { return settingsResponse(request.method === 'GET' ? storage.settings.read() : storage.settings.update(request.body)); }
      catch (error) { return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status }); }
    });
    await f.panel.load(); f.panel.nodes.providerApiKey.value = NEXT_KEY;
    const fsync = fs.fsyncSync;
    try {
      // The real settings implementation renames successfully before this flush.
      fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Error('synthetic directory flush failure ' + NEXT_KEY); return fsync(fd); };
      await assert.rejects(f.panel[action](), { code: 'CONFIG_STORAGE_UNAVAILABLE' });
    } finally { fs.fsyncSync = fsync; }
    const message = f.panel.nodes.providerError.textContent;
    assert.match(message, /配置存储出现错误/);
    assert.match(message, action === 'save' ? /配置是否已保存尚未确认/ : /本地 Key 是否已删除尚未确认/);
    assert.match(message, /目录权限或磁盘状态.*重新载入配置核对/);
    assert.doesNotMatch(message, /本次请求未修改|自动重试|请求编号/);
    assert.equal(f.panel.nodes.providerApiKey.value, ''); assert.equal(f.requests.length, 2); noSecrets(f.visible());
    assert.equal(storage.settings.read().revision, 2, 'a storage error does not establish that the write was rejected');
    assert.equal(storage.settings.read().hasLocalApiKey, action === 'save');
    await f.panel.load();
    if (action === 'save') assert.equal(f.panel.nodes.providerError.textContent, '');
    else assert.match(f.panel.nodes.providerError.textContent, /图像服务配置未就绪/);
    assert.equal(f.panel.nodes.providerClearKey.disabled, action === 'clearKey');
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1); noSecrets(f.visible());
  }
});

test('provider form caller errors stay safe when the professional controller reports them', async t => {
  for (const action of ['load', 'save', 'clearKey']) {
    for (const errorCode of ['NETWORK_ERROR', 'CONFIG_STORAGE_CORRUPT', 'CONFIG_REVISION_CONFLICT', 'CAPABILITY_UNAVAILABLE', 'BODY_TOO_LARGE', 'CONFIG_STORAGE_UNAVAILABLE', KEY]) {
      const f = formFixture(t, request => request.method === 'GET' && action !== 'load' ? settingsResponse(formState())
        : Response.json({ ok: false, error: { code: errorCode, message: '提交结果尚未确认，原请求编号 ' + KEY, details: { apiKey: NEXT_KEY } } }, { status: 503 }));
      const controller = createController({ transport: { call() { throw Error('Settings errors must not dispatch tasks'); } } });
      t.after(() => controller.dispose());
      if (action !== 'load') await f.panel.load();
      f.panel.nodes.providerApiKey.value = NEXT_KEY;
      let outward;
      // Mirror studio-014.js handle().catch(showError) -> reportError.
      await f.panel[action]().catch(error => { outward = error; controller.reportError(error); });
      assert.ok(outward instanceof Error); assert.equal(outward.code, errorCode === KEY ? 'CONFIG_OPERATION_FAILED' : errorCode);
      assert.equal(outward.details, undefined); assert.equal(outward.cause, undefined);
      assert.equal(outward.message, f.panel.nodes.providerError.textContent);
      const reported = controller.snapshot();
      assert.deepEqual(reported.error, { code: outward.code, message: outward.message });
      assert.equal(reported.pendingRun, null); assert.deepEqual(reported.jobs, []);
      assert.doesNotMatch(reported.error.message, /提交结果尚未确认|原请求编号|自动重试|刷新任务/);
      noSecrets({ message: outward.message, stack: outward.stack, code: outward.code, details: outward.details, state: reported });
      noSecrets(f.visible()); assert.equal(f.requests.length, action === 'load' ? 1 : 2);
    }
  }
});

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
