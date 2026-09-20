const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { mount } = require('../plugin/studio-014');
const composer = require('../plugin/composer-014');

class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = new Map(); this.className = ''; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.parentElement = null;
    this.classList = { add: name => { const a = new Set(this.className.split(' ')); a.add(name); this.className = [...a].join(' '); }, remove: name => { this.className = this.className.split(' ').filter(s => s !== name).join(' '); }, contains: name => this.className.split(' ').includes(name), toggle: (name, on) => { if (on) this.classList.add(name); else this.classList.remove(name); } };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(v => v !== child); child.parentElement = null; return child; }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(_) { throw Error('Untrusted content must never enter innerHTML'); }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
  click() { this.dispatchEvent(new Event('click')); }
}
function fixture() {
  const doc = new EventTarget(); doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement('body'); doc.querySelectorAll = () => [];
  doc.getElementById = id => { function find(el) { if (el.id === id) return el; for (const child of el.children) { const found = find(child); if (found) return found; } return null; } return find(doc.body); };
  for (const id of ['pane-pro', 'proRow', 'proComposer', 'baseUrl', 'prompt']) { const element = doc.createElement(id === 'prompt' ? 'textarea' : 'div'); element.id = id; doc.body.appendChild(element); }
  const values = new Map(), calls = [], win = { document: doc, location: { protocol: 'http:', pathname: '/ui/', origin: 'http://localhost:17881' }, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, PXD_COMPOSER: composer, PXD_CONTEXT: { isPhotoshop: false }, PXD_NAV: { baseUrl: () => 'http://localhost:17881', showTab: tab => calls.push({ operation: 'showTab', tab }) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../plugin/ui-014'), 'utf8'), { window: win, document: doc, Event });
  const draft = { draftId: 'draft-1', revision: 1, capabilityId: 'image.edit', params: { prompt: 'Keep the details <not HTML>' }, context: { documentRef: { documentId: 1, historyStateId: 10, name: 'source.psd' }, scope: 'selection', transform: { inputWidth: 4, inputHeight: 3 }, baseAssetId: 'source-1', refs: [], preserve: [], settings: { autoApply: false, groupResults: false } } };
  let configured = false, jobs = [], providerOverride = null;
  const transport = { base: 'http://localhost:17881', readAsset: async assetId => { calls.push({ operation: 'readAsset', assetId }); return 'data:image/png;base64,AA=='; }, call: async (operation, args) => {
    calls.push({ operation, args });
    if (operation === 'discover') return { photoshop: { connected: true }, provider: providerOverride || { configured, model: 'fixture', settings: { aspectRatio: ['auto'], imageSize: ['1K'] } } };
    if (operation === 'listDrafts') return [structuredClone(draft)];
    if (operation === 'listJobs') return structuredClone(jobs);
    if (operation === 'getDraft') return structuredClone(draft);
    if (operation === 'updateDraft') { draft.revision++; (args.unsetParams || []).forEach(name => { delete draft.params[name]; }); draft.params = { ...draft.params, ...args.params }; draft.context = args.context; return structuredClone(draft); }
    if (operation === 'run') { const job = { jobId: 'job-1', requestId: args.requestId, snapshot: structuredClone(draft), status: 'queued', results: [], placement: { status: 'not-requested' } }; jobs = [job]; return { job: structuredClone(job), duplicate: false }; }
    throw Error('Unexpected operation ' + operation);
  } };
  const mounted = mount({ window: win, document: doc, transport, poll: false });
  return { doc, win, calls, mounted, storage: values, ready: () => mounted.controller.refresh(), configure: () => { configured = true; }, setProvider: value => { providerOverride = value; }, draft };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function selectOption(select, value) {
  const option = select.children.find(item => item.value === value);
  assert.ok(option, 'The user must have an option for ' + value);
  assert.equal(select.disabled, false, 'The select must be enabled');
  assert.equal(option.disabled, false, 'The chosen option must be enabled');
  select.value = value; select.dispatchEvent(new Event('change'));
}
test('mounted workspace displays shared draft, protects missing-provider action and populates Agent with record identity', async () => {
  const f = fixture(); try {
    await f.ready(); await turn();
    assert.equal(f.doc.getElementById('proRow').hidden, true); assert.equal(f.mounted.nodes.studioPrompt.value, f.draft.params.prompt);
    assert.equal(f.win.PXD_UI.isDisabled(f.mounted.nodes.studioRun), true); assert.match(f.mounted.nodes.studioService.textContent, /图像服务未配置/);
    f.mounted.nodes.studioRun.click(); await turn(); assert.equal(f.calls.some(c => c.operation === 'run'), false);
    assert.equal(f.mounted.nodes.studioSourceImage.src, 'data:image/png;base64,AA==');
    f.mounted.nodes.studioToAgent.click(); await turn(); assert.match(f.doc.getElementById('prompt').value, /draft-1/); assert.match(f.doc.getElementById('prompt').value, /studio_get_draft/);
    assert.equal(f.calls.some(c => c.operation === 'agent/turn' || c.operation === 'run'), false);
  } finally { f.mounted.dispose(); }
});
test('mounted professional composer routes edits/save/run; Shift and IME Enter never submit', async () => {
  const f = fixture(); try {
    await f.ready(); f.configure(); await f.ready(); const input = f.mounted.nodes.studioPrompt;
    input.focus(); input.value = 'New edit'; input.dispatchEvent(new Event('input'));
    assert.equal(f.mounted.controller.snapshot().dirty, true); assert.equal(f.win.PXD_UI.isDisabled(f.mounted.nodes.studioToAgent), true);
    assert.equal(f.win.PXD_UI.isDisabled(f.mounted.nodes.studioRun), false);
    function key(values) { const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Enter', ...values }); input.dispatchEvent(event); return event; }
    assert.equal(key({ shiftKey: true }).defaultPrevented, false); assert.equal(key({ isComposing: true }).defaultPrevented, false); assert.equal(f.calls.some(c => c.operation === 'run'), false);
    assert.equal(key({ shiftKey: false }).defaultPrevented, true); await turn(); await turn();
    assert.equal(f.calls.filter(c => c.operation === 'run').length, 1); assert.equal(f.calls.filter(c => c.operation === 'updateDraft').length, 1); assert.equal(f.draft.params.prompt, 'New edit');
    assert.ok(f.calls.every(c => !['/apply', '/plan', '/job'].includes(c.operation)));
  } finally { f.mounted.dispose(); }
});
test('model-specific output choices, input budget and resetting saved overrides stay visible and consistent', async () => {
  const { createGeminiProvider } = require('../companion/providers'); const f = fixture();
  try {
    f.setProvider(createGeminiProvider({ env: {}, config: { apiKey: 'fixture-view-provider-secret' } }).describe());
    f.draft.context.selectionMaskAssetId = 'mask-1'; f.draft.revision++; await f.ready(); await f.ready(); await turn();
    const nodes = f.mounted.nodes;
    assert.match(nodes.studioInputBudget.textContent, /2 \/ 3/);
    assert.deepEqual(nodes.studioImageSize.children.map(option => option.value), ['']);
    nodes.studioModel.value = 'gemini-3-pro-image-preview'; nodes.studioModel.dispatchEvent(new Event('input'));
    assert.match(nodes.studioInputBudget.textContent, /2 \/ 14/);
    assert.deepEqual(nodes.studioImageSize.children.map(option => option.value), ['', '1K', '2K', '4K']);
    selectOption(nodes.studioRatio, '1:1'); selectOption(nodes.studioImageSize, '2K');
    await f.mounted.controller.save();
    selectOption(nodes.studioRatio, ''); selectOption(nodes.studioImageSize, '');
    await f.mounted.controller.save();
    assert.equal(f.draft.params.aspectRatio, undefined); assert.equal(f.draft.params.imageSize, undefined);
    assert.deepEqual(f.calls.filter(call => call.operation === 'updateDraft').at(-1).args.unsetParams.sort(), ['aspectRatio', 'imageSize']);
    selectOption(nodes.studioRatio, '1:1'); selectOption(nodes.studioImageSize, '2K');
    await f.mounted.controller.save();
    nodes.studioModel.value = ''; nodes.studioModel.dispatchEvent(new Event('input'));
    assert.equal(f.win.PXD_UI.isDisabled(nodes.studioRun), true); assert.match(nodes.studioInputIssue.textContent, /不支持.*尺寸/);
    selectOption(nodes.studioImageSize, ''); selectOption(nodes.studioRatio, '');
    assert.equal(f.win.PXD_UI.isDisabled(nodes.studioRun), false);
    await f.mounted.controller.save(); await f.ready();
    assert.equal(f.draft.params.model, undefined); assert.equal(f.draft.params.imageSize, undefined); assert.equal(f.draft.params.aspectRatio, undefined);
    assert.deepEqual(f.calls.filter(call => call.operation === 'updateDraft').at(-1).args.unsetParams.sort(), ['aspectRatio', 'imageSize', 'model']);
    nodes.studioTemperature.value = '3'; nodes.studioTemperature.dispatchEvent(new Event('input')); assert.equal(f.win.PXD_UI.isDisabled(nodes.studioRun), true);
    nodes.studioTemperature.value = ''; nodes.studioTemperature.dispatchEvent(new Event('input')); assert.equal(f.win.PXD_UI.isDisabled(nodes.studioRun), false);
    assert.equal(f.calls.some(call => call.operation === 'run'), false);
  } finally { f.mounted.dispose(); }
});
test('provider settings form writes the password once, clears it immediately and respects environment-owned fields', async () => {
  const settingsUi = require('../plugin/provider-settings-014'); const f = fixture(), calls = [], secret = 'fixture-form-secret-19284'; let release, refreshed = 0;
  const parent = f.doc.createElement('div'); f.doc.body.appendChild(parent);
  let state = { revision: 0, baseUrl: 'https://example.test', model: 'gemini-2.5-flash-image', timeoutMs: 180000, sources: { baseUrl: 'default', model: 'default', timeoutMs: 'default', apiKey: 'default' }, hasApiKey: false, hasLocalApiKey: false, configured: false };
  const panel = settingsUi.mount({ document: f.doc, parent, ui: f.win.PXD_UI, transport: {
    getProviderSettings: async () => structuredClone(state),
    updateProviderSettings: async patch => { calls.push(structuredClone(patch)); await new Promise(resolve => { release = resolve; }); state = { ...state, revision: state.revision + 1, hasApiKey: !patch.clearApiKey, hasLocalApiKey: !patch.clearApiKey, configured: !patch.clearApiKey, sources: { ...state.sources, apiKey: patch.clearApiKey ? 'default' : 'local' } }; return structuredClone(state); }
  }, onSaved: () => { refreshed++; } });
  try {
    await panel.load(); assert.equal(panel.nodes.providerApiKey.type, 'password'); assert.equal(panel.nodes.providerApiKey.value, '');
    panel.nodes.providerApiKey.value = secret; const saving = panel.save();
    assert.equal(panel.nodes.providerApiKey.value, ''); assert.equal(calls[0].apiKey, secret); assert.equal(calls[0].expectedRevision, 0);
    release(); await saving; assert.equal(refreshed, 1); assert.match(panel.nodes.providerKeyStatus.textContent, /已提供 Key/); assert.equal(panel.nodes.providerApiKey.value, '');
    assert.ok(![...f.storage.values()].some(value => String(value).includes(secret)));
    const clearing = panel.clearKey(); release(); await clearing; assert.deepEqual(calls[1], { expectedRevision: 1, clearApiKey: true });
    state.sources.apiKey = 'environment'; state.sources.baseUrl = 'environment'; state.hasApiKey = true; await panel.load();
    assert.equal(panel.nodes.providerApiKey.disabled, true); assert.equal(panel.nodes.providerEndpoint.disabled, true); assert.equal(panel.nodes.providerDefaultModel.disabled, false);
    assert.match(panel.nodes.providerSources.textContent, /环境变量/); assert.equal(panel.nodes.providerApiKey.value, '');
  } finally { panel.dispose(); f.mounted.dispose(); }
});
