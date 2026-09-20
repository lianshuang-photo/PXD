'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createController, createFileIO, parseImport, mount } = require('../plugin/presets-014');
const { createRecipeLibrary } = require('../companion/presets');
const { createRecipeCatalog } = require('../companion/capabilities/recipes');
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.value = ''; this.style = {}; this.className = ''; this.disabled = false; this.hidden = false; this.attributes = new Map(); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentElement = null; }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(_) { throw Error('No untrusted HTML'); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-presets-ui-')); t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const library = createRecipeLibrary({ rootDir, factoryCatalog: createRecipeCatalog() }), calls = [], used = [], files = [];
  const map = { listRecipes: 'list', createRecipe: 'create', copyRecipe: 'copy', updateRecipe: 'update', importRecipe: 'import', exportRecipe: 'export', listRecipeVersions: 'versions', archiveRecipe: 'archive', restoreRecipe: 'restore' };
  const transport = { call: async (operation, args) => { calls.push({ operation, args: structuredClone(args) }); return operation === 'getRecipe' ? library.get(args.recipeId, args.revision) : library[map[operation]](['createRecipe', 'copyRecipe', 'updateRecipe', 'importRecipe', 'archiveRecipe', 'restoreRecipe'].includes(operation) ? { ...args, source: 'ui' } : args); } };
  const doc = { createElement: tag => new Element(tag) }; doc.body = doc.createElement('body');
  const ui = { createButton: (className, text, action) => { const el = doc.createElement('div'); el.className = className; el.textContent = text; el.addEventListener('click', () => { if (!el.disabled) action(); }); return el; }, setDisabled: (el, value) => { el.disabled = !!value; } };
  const container = doc.createElement('div'); doc.body.appendChild(container);
  const fileIO = { read: async () => files[0], save: async text => { files.push(text); return true; } };
  const mounted = mount({ container, document: doc, window: {}, ui, transport, fileIO, onUse: async id => { used.push(id); } });
  t.after(() => mounted.dispose());
  return { library, transport, calls, used, files, doc, mounted, nodes: mounted.nodes };
}
async function settle(controller) { for (let i = 0; i < 30; i++) { await new Promise(resolve => setImmediate(resolve)); if (!controller.snapshot().busy) return; } assert.fail('UI did not finish'); }
function type(input, value) { input.value = value; input.dispatchEvent(new Event('input')); }
test('mounted preset manager copies factory definitions, saves edits and exports/imports via actual controls', async t => {
  const f = fixture(t), c = f.mounted.controller;
  await f.mounted.refresh(); await c.select('f_013');
  assert.equal(f.nodes.presetTitle.disabled, true); assert.equal(f.nodes.presetSave.disabled, true);
  f.nodes.presetCopy.click(); await settle(c); assert.equal(c.snapshot().selected.kind, 'user'); assert.equal(f.nodes.presetTitle.disabled, false);
  type(f.nodes.presetTitle, '<script>not HTML</script>'); f.nodes.presetSave.click(); await settle(c);
  assert.equal(c.snapshot().selected.title, '<script>not HTML</script>'); assert.equal(c.snapshot().selected.revision, 2); assert.equal(c.snapshot().error, null);
  f.nodes.presetUse.click(); await settle(c); assert.deepEqual(f.used, [c.snapshot().selected.recipeId]);
  f.nodes.presetExport.click(); await settle(c); assert.equal(JSON.parse(f.files[0]).definition.title, '<script>not HTML</script>');
  const original = c.snapshot().selected.recipeId;
  f.nodes.presetImport.click(); await settle(c); assert.notEqual(c.snapshot().selected.recipeId, original); assert.equal(c.snapshot().selected.title, '<script>not HTML</script>');
  assert.ok(f.calls.every(call => !['run', 'capture', 'apply'].includes(call.operation)));
});
test('reference-slot editor persists labels and roles; archive/history restore use optimistic versions', async t => {
  const f = fixture(t), c = f.mounted.controller;
  type(f.nodes.presetTitle, 'Reference preset'); f.nodes.presetAddSlot.click();
  type(f.nodes.presetSlotLabel_0, 'Person identity'); f.nodes.presetSlotRole_0.value = 'identity'; f.nodes.presetSlotRole_0.dispatchEvent(new Event('change'));
  f.nodes.presetSave.click(); await settle(c); const id = c.snapshot().selected.recipeId;
  assert.equal(f.library.get(id).refImages[0].role, 'identity'); assert.equal(f.library.get(id).refImages[0].label, 'Person identity');
  type(f.nodes.presetTitle, 'Later title'); f.nodes.presetSave.click(); await settle(c);
  f.nodes.presetArchive.click(); await settle(c); assert.equal(c.snapshot().selected.archived, true); assert.equal(f.nodes.presetUse.disabled, true);
  f.nodes.presetVersions.value = '1'; f.nodes.presetRestore.click(); await settle(c);
  assert.equal(c.snapshot().selected.title, 'Reference preset'); assert.equal(c.snapshot().selected.revision, 4); assert.equal(c.snapshot().selected.archived, false);
});
test('background refresh preserves expanded pages and a later-page selection until filters change', async t => {
  const f = fixture(t), c = f.mounted.controller;
  await f.mounted.refresh(); assert.equal(c.snapshot().items.length, 20);
  f.nodes.presetMore.click(); await settle(c); f.nodes.presetMore.click(); await settle(c);
  const expanded = c.snapshot().items.map(item => item.recipeId), later = expanded[48];
  assert.equal(expanded.length, 60); f.nodes['preset_' + later].click(); await settle(c);
  const selected = c.snapshot().selected;
  await f.mounted.refresh(); await f.mounted.refresh();
  assert.deepEqual(c.snapshot().items.map(item => item.recipeId), expanded);
  assert.equal(f.nodes.presetList.children.length, 60); assert.deepEqual(c.snapshot().selected, selected);
  assert.equal(c.snapshot().form.title, selected.title); assert.equal(c.snapshot().nextOffset, 60);
  await c.search('', 'factory', false);
  assert.equal(c.snapshot().items.length, 20); assert.equal(c.snapshot().selected.recipeId, later);
});
test('an overlapping refresh retains a requested larger window and respects the API page bound', async t => {
  const items = Array.from({ length: 245 }, (_, i) => ({ recipeId: 'fixture_' + i, title: 'Preset ' + i })), calls = [];
  let delayed, resolveDelayed;
  const c = createController({ transport: { call: async (operation, args) => {
    assert.equal(operation, 'listRecipes'); assert.ok(args.limit <= 200); calls.push(args);
    const page = { items: items.slice(args.offset, args.offset + args.limit), total: items.length, nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null };
    if (delayed) { delayed = false; await new Promise(resolve => { resolveDelayed = resolve; }); }
    return page;
  } }, onUse: async () => {} }); t.after(() => c.dispose());
  await c.refresh(); delayed = true; const more = c.refresh(true); await c.refresh(); resolveDelayed(); await more;
  assert.equal(c.snapshot().items.length, 40);
  for (let i = 0; i < 9; i++) await c.refresh(true);
  assert.equal(c.snapshot().items.length, 220); const before = calls.length;
  await c.refresh(); assert.equal(c.snapshot().items.length, 220); assert.equal(c.snapshot().nextOffset, 220);
  assert.deepEqual(calls.slice(before).map(call => [call.offset, call.limit]), [[0, 200], [200, 20]]);
});
test('discard control releases unsaved new presets and reloads existing edits without mutations', async t => {
  const f = fixture(t), c = f.mounted.controller;
  await f.mounted.refresh(); f.nodes.presetNew.click(); type(f.nodes.presetTitle, 'Unsaved new preset');
  await assert.rejects(c.select('f_013'), { code: 'UNSAVED_PRESET' });
  assert.equal(f.nodes.presetReload.disabled, false); assert.equal(f.nodes.presetReload.textContent, '放弃未保存预设');
  const before = f.calls.length; f.nodes.presetReload.click(); await settle(c);
  assert.equal(f.calls.length, before); assert.equal(c.snapshot().dirty, false); assert.equal(c.snapshot().selected, null);
  assert.equal(c.snapshot().form.title, ''); assert.equal(c.snapshot().error, null); assert.equal(f.library.list({ kind: 'user' }).total, 0);
  await c.select('f_013'); await c.copy(); const saved = c.snapshot().selected;
  type(f.nodes.presetTitle, 'Unsaved edit'); f.nodes.presetReload.click(); await settle(c);
  assert.equal(c.snapshot().form.title, saved.title); assert.equal(c.snapshot().dirty, false); assert.equal(c.snapshot().selected.revision, saved.revision);
});
test('ambiguous creation retry keeps one request identity and dirty edits cannot silently switch presets', async t => {
  const f = fixture(t); let interrupted = false;
  const transport = { call: async (op, args) => { const result = await f.transport.call(op, args); if (op === 'createRecipe' && !interrupted) { interrupted = true; throw Object.assign(Error('Response lost'), { code: 'NETWORK_ERROR' }); } return result; } };
  const c = createController({ transport, onUse: async () => {} }); t.after(() => c.dispose());
  c.edit({ title: 'One durable preset' }); await assert.rejects(c.save(), { code: 'NETWORK_ERROR' }); await c.save();
  assert.equal(f.library.list({ kind: 'user' }).total, 1);
  const requests = f.calls.filter(item => item.operation === 'createRecipe'); assert.equal(requests[0].args.requestId, requests[1].args.requestId);
  c.edit({ title: 'Unsaved' }); await assert.rejects(c.select('f_013'), { code: 'UNSAVED_PRESET' }); assert.equal(c.snapshot().form.title, 'Unsaved');
  c.dispose(); const count = f.calls.length; await assert.rejects(c.save(), { code: 'DISPOSED' }); assert.equal(f.calls.length, count);
});
test('UXP JSON picker handles cancellation, bounds and UTF-8 export without arbitrary server paths', async () => {
  let chosen = null, written, metadata = { size: 40 };
  const storage = { formats: { utf8: 'utf8' }, localFileSystem: { getFileForOpening: async () => chosen, getFileForSaving: async () => chosen } };
  const io = createFileIO({ native: true, requireImpl: name => { assert.equal(name, 'uxp'); return { storage }; } });
  assert.equal(await io.read(), null); assert.equal(await io.save('{}'), false);
  chosen = { getMetadata: async () => metadata, read: async options => { assert.equal(options.format, 'utf8'); return '{"title":"人物"}'; }, write: async (text, options) => { written = { text, options }; } };
  assert.equal(await io.read(), '{"title":"人物"}'); assert.equal(await io.save('{"title":"人物"}'), true); assert.equal(written.options.format, 'utf8');
  metadata.size = 512 * 1024 + 1; await assert.rejects(io.read(), { code: 'INVALID_RECIPE' });
  assert.throws(() => parseImport('{bad'), { code: 'INVALID_RECIPE' }); assert.throws(() => parseImport('界'.repeat(200000)), { code: 'INVALID_RECIPE' });
});
