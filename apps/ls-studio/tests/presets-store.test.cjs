'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecipeCatalog } = require('../companion/capabilities/recipes');
const { createRecipeLibrary } = require('../companion/presets');
const definition = () => ({ title: 'Hair <detail>', category: 'hair', subCategory: 'edges', content: '{"instruction":"Keep identity","nested":{"@param:细节":0.5}}', refImages: [{ slotId: 'identity', label: '人物参考', role: 'identity' }] });
function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-presets-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const factoryCatalog = createRecipeCatalog(), open = () => createRecipeLibrary({ rootDir, factoryCatalog });
  return { rootDir, factoryCatalog, open, library: open() };
}
function create(library, requestId = 'create-one', value = definition()) { return library.create({ definition: value, source: 'ui', requestId }); }
test('create, edit, immutable versions and restore survive restart with optimistic conflicts', t => {
  const { library, open } = setup(t), created = create(library);
  const edited = library.update({ recipeId: created.recipeId, expectedRevision: 1, definition: { ...definition(), title: 'Agent revision' }, source: 'agent' });
  assert.equal(edited.revision, 2); assert.equal(edited.source, 'agent');
  assert.throws(() => library.update({ recipeId: created.recipeId, expectedRevision: 1, definition: definition(), source: 'ui' }), e => e.code === 'RECIPE_REVISION_CONFLICT' && e.details.current.revision === 2);
  assert.equal(library.get(created.recipeId, 1).title, created.title);
  const restored = library.restore({ recipeId: created.recipeId, expectedRevision: 2, targetRevision: 1, source: 'ui' });
  assert.equal(restored.revision, 3); assert.equal(restored.sourceHash, created.sourceHash);
  assert.equal(open().get(created.recipeId).title, created.title);
  assert.deepEqual(open().versions({ recipeId: created.recipeId }).map(v => v.revision), [3, 2, 1]);
  restored.refImages[0].label = 'mutated'; assert.equal(library.get(created.recipeId).refImages[0].label, '人物参考');
});
test('factory copy is independently editable; neither mutations nor imports overwrite factory IDs', t => {
  const { library, factoryCatalog } = setup(t), before = factoryCatalog.get('f_013');
  assert.throws(() => library.archive({ recipeId: 'f_013', expectedRevision: 1, source: 'ui' }), { code: 'RECIPE_READ_ONLY' });
  const copied = library.copy({ recipeId: 'f_013', expectedSourceHash: before.sourceHash, requestId: 'copy-once', source: 'ui' });
  assert.equal(copied.kind, 'user'); assert.notEqual(copied.recipeId, before.recipeId);
  assert.deepEqual(copied.origin, { recipeId: 'f_013', sourceHash: before.sourceHash });
  assert.equal(copied.content, before.content);
  library.update({ recipeId: copied.recipeId, expectedRevision: 1, definition: definition(), source: 'agent' });
  assert.deepEqual(factoryCatalog.get('f_013'), before);
  assert.throws(() => library.copy({ recipeId: 'f_013', expectedSourceHash: '0'.repeat(64), requestId: 'stale-copy', source: 'ui' }), { code: 'RECIPE_REVISION_CONFLICT' });
});
test('request identity prevents duplicate creations/imports after restart and rejects content reuse', t => {
  const f = setup(t), first = create(f.library);
  assert.equal(create(f.open()).recipeId, first.recipeId);
  assert.throws(() => create(f.library, 'create-one', { ...definition(), title: 'different' }), { code: 'REQUEST_CONFLICT' });
  const bundle = f.library.export({ recipeId: first.recipeId });
  const imported = f.library.import({ bundle, requestId: 'import-once', source: 'agent' });
  assert.notEqual(imported.recipeId, first.recipeId); assert.equal(imported.content, first.content);
  assert.equal(f.open().import({ bundle, requestId: 'import-once', source: 'agent' }).recipeId, imported.recipeId);
  assert.deepEqual(Object.keys(bundle).sort(), ['definition', 'format', 'schemaVersion']);
  assert.equal(JSON.stringify(bundle).includes(first.recipeId), false);
});
test('archives disappear from normal queries; restoring appends history and never deletes definitions', t => {
  const { library } = setup(t), first = create(library);
  library.archive({ recipeId: first.recipeId, expectedRevision: 1, source: 'ui' });
  assert.equal(library.list({ kind: 'user' }).total, 0);
  assert.equal(library.list({ kind: 'user', includeArchived: true }).items[0].archived, true);
  assert.throws(() => library.compile({ recipeId: first.recipeId, expectedSourceHash: first.sourceHash }), { code: 'RECIPE_ARCHIVED' });
  assert.throws(() => library.update({ recipeId: first.recipeId, expectedRevision: 2, definition: definition(), source: 'ui' }), { code: 'RECIPE_ARCHIVED' });
  const restored = library.restore({ recipeId: first.recipeId, expectedRevision: 2, source: 'agent' });
  assert.equal(restored.revision, 3); assert.equal(restored.archived, false);
  assert.equal(library.list({ kind: 'user', q: 'identity', category: 'hair' }).total, 1);
});
test('loading uses the selected definition hash and explicit ordered role mappings', t => {
  const { library } = setup(t), first = create(library);
  const input = { recipeId: first.recipeId, expectedSourceHash: first.sourceHash, values: { 细节: 0.75 }, refs: [{ assetId: 'asset-one', role: 'identity' }] };
  const compiled = library.compile(input); assert.equal(JSON.parse(compiled.prompt).nested['@param:细节'], 0.75);
  for (const refs of [undefined, [], [{ assetId: 'asset-one', role: 'style' }]]) assert.throws(() => library.compile({ ...input, refs }), { code: 'REFERENCE_REQUIRED' });
  assert.throws(() => library.compile({ ...input, expectedSourceHash: undefined }), { code: 'RECIPE_REVISION_CONFLICT' });
  library.update({ recipeId: first.recipeId, expectedRevision: 1, definition: { ...definition(), content: '{"instruction":"changed"}' }, source: 'ui' });
  assert.throws(() => library.compile(input), { code: 'RECIPE_REVISION_CONFLICT' });
  assert.equal(compiled.recipe.sourceHash, first.sourceHash); assert.equal(JSON.parse(compiled.prompt).instruction, 'Keep identity');
});
test('malformed imports, unknown schema, paths, unsafe content and duplicate slots leave library unchanged', t => {
  const { library } = setup(t), good = { schemaVersion: 1, format: 'ls-studio-preset', definition: definition() };
  const bad = [ { ...good, schemaVersion: 2 }, { ...good, path: '/tmp/preset.json' }, { ...good, definition: { ...definition(), recipeId: 'f_013' } },
    { ...good, definition: { ...definition(), refImages: [{ path: '/tmp/photo.png' }] } },
    { ...good, definition: { ...definition(), content: '{"__proto__":{"x":1}}' } },
    { ...good, definition: { ...definition(), content: '{"@param:weight":2}' } },
    { ...good, definition: { ...definition(), refImages: [...definition().refImages, ...definition().refImages] } },
    { ...good, definition: { ...definition(), refImages: false } }, { ...good, definition: { ...definition(), title: '  ' } } ];
  for (const bundle of bad) assert.throws(() => library.import({ bundle, requestId: 'bad-import', source: 'ui' }));
  assert.equal(library.list({ kind: 'user' }).total, 0);
});
test('failed atomic publication preserves the previous revision and corrupt/missing state fails closed', t => {
  const f = setup(t), first = create(f.library), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.basename(from).startsWith('.presets-')) throw Error('fixture write failure'); return rename(from, to); };
  try { assert.throws(() => f.library.update({ recipeId: first.recipeId, expectedRevision: 1, definition: { ...definition(), title: 'Not saved' }, source: 'ui' }), { code: 'STORAGE_UNAVAILABLE' }); }
  finally { fs.renameSync = rename; }
  assert.equal(f.open().get(first.recipeId).revision, 1);
  fs.writeFileSync(path.join(f.rootDir, 'presets.json'), '{broken'); assert.throws(f.open, { code: 'STORAGE_CORRUPT' });
  fs.rmSync(path.join(f.rootDir, 'presets.json')); assert.throws(f.open, { code: 'STORAGE_CORRUPT' });
});
