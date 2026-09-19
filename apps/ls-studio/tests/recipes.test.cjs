'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRecipeCatalog } = require('../companion/capabilities/recipes');

const factoryDir = path.join(__dirname, '../companion/factory_presets');
const makePreset = (overrides = {}) => ({
  id: 'fixture', title: 'Hair detail', category: 'hair', subCategory: 'edges',
  content: JSON.stringify({ role: 'Retoucher', '@param:细节': 0.5, '@param:细节_desc': '0=original;1=full detail', operations: { target: 'Flyaway edges' } }),
  refImages: [], _isFactory: true, ...overrides,
});
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-recipes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t, preset = makePreset()) {
  const rootDir = directory(t), file = path.join(rootDir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(preset, null, 2));
  return { rootDir, file, catalog: createRecipeCatalog({ rootDir }) };
}

test('all 121 bundled recipes preserve complete content and all 101 numeric parameters', () => {
  const catalog = createRecipeCatalog(), listed = catalog.list({ limit: 200 });
  assert.equal(listed.total, 121); assert.equal(listed.items.length, 121); assert.equal(listed.nextOffset, null);
  let parameters = 0;
  for (const item of listed.items) {
    const bytes = fs.readFileSync(path.join(factoryDir, item.recipeId + '.json'));
    const original = JSON.parse(bytes), recipe = catalog.get(item.recipeId);
    const compiled = catalog.compile({ recipeId: item.recipeId });
    assert.equal(recipe.content, original.content);
    assert.deepEqual(JSON.parse(compiled.prompt), JSON.parse(original.content));
    assert.equal(recipe.sourceHash, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(compiled.recipe, { recipeId: item.recipeId, sourceHash: recipe.sourceHash, values: Object.fromEntries(recipe.parameters.map(parameter => [parameter.id, parameter.defaultValue])) });
    parameters += recipe.parameters.length;
  }
  assert.equal(parameters, 101);
  assert.equal(catalog.get('f_000').title, '面部精修1111');
});

test('compile resolves defaults and exact aliases without truncating Chinese parameter IDs or descriptions', () => {
  const catalog = createRecipeCatalog(), recipe = catalog.get('f_013');
  const userText = '  Only adjust the requested features.\n保留本人身份和眼镜。  ';
  const result = catalog.compile({ recipeId: 'f_013', values: { 下颌线锐化: 0, '@param:磨皮强度': 1 }, userText });
  const expected = JSON.parse(recipe.content); expected['@param:下颌线锐化'] = 0; expected['@param:磨皮强度'] = 1;
  assert.equal(result.prompt, JSON.stringify(expected) + '\n\n' + userText);
  assert.equal(result.recipe.values.下颌线锐化, 0); assert.equal(result.recipe.values.磨皮强度, 1);
  assert.equal(result.recipe.values.颧骨立体感, 0.6); assert.equal(Object.keys(result.recipe.values).length, 9);
  assert.equal(catalog.get('f_013').parameters[0].defaultValue, 0.8);
  assert.equal(expected['@param:下颌线锐化_desc'], JSON.parse(recipe.content)['@param:下颌线锐化_desc']);
});

test('nested parameters, descriptions and unrelated arrays survive compilation', t => {
  const content = { nested: [{ '@param:光感': 0.2, '@param:光感_desc': 'Keep exact', notes: ['one', { preserve: true }] }], integration: { direction: 'left' } };
  const { catalog } = fixture(t, makePreset({ content: JSON.stringify(content, null, 2) }));
  assert.equal(catalog.get('fixture').content, JSON.stringify(content, null, 2));
  const compiled = catalog.compile({ recipeId: 'fixture', values: { 光感: 0.75 } });
  content.nested[0]['@param:光感'] = 0.75;
  assert.deepEqual(JSON.parse(compiled.prompt), content);
  assert.deepEqual(catalog.get('fixture').parameters, [{ id: '光感', key: '@param:光感', label: '光感', defaultValue: 0.2, min: 0, max: 1, step: 0.01, description: 'Keep exact' }]);
});

test('unknown, ambiguous, nonnumeric and out-of-range parameter overrides fail', t => {
  const { catalog } = fixture(t);
  for (const value of [NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', null, false]) {
    assert.throws(() => catalog.compile({ recipeId: 'fixture', values: { 细节: value } }), { code: 'INVALID_INPUT' });
  }
  for (const values of [{ unknown: 0.5 }, { '细节_desc': 0.5 }, { '@param:细节_desc': 0.5 }, { 细节: 0.5, '@param:细节': 0.5 }, JSON.parse('{"__proto__":0.5}')]) {
    assert.throws(() => catalog.compile({ recipeId: 'fixture', values }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => catalog.compile({ recipeId: 'fixture', values: [] }), { code: 'INVALID_INPUT' });
  assert.throws(() => catalog.compile({ recipeId: 'fixture', userText: 7 }), { code: 'INVALID_INPUT' });
  assert.throws(() => catalog.compile({ recipeId: 'fixture', userText: 'x'.repeat(64000) }), { code: 'INVALID_INPUT' });
});

test('references retain managed IDs and roles, including an explicit empty array', t => {
  const { catalog } = fixture(t), refs = [{ assetId: 'managed-reference', role: 'identity' }];
  const compiled = catalog.compile({ recipeId: 'fixture', refs });
  assert.deepEqual(compiled.refs, refs); refs[0].role = 'style';
  assert.equal(compiled.refs[0].role, 'identity');
  assert.deepEqual(catalog.compile({ recipeId: 'fixture', refs: [] }).refs, []);
  assert.equal(Object.hasOwn(catalog.compile({ recipeId: 'fixture' }), 'refs'), false);
  for (const invalid of [[{ assetId: 'https://example.com/image.png', role: 'reference' }], [{ path: '/tmp/reference.png', role: 'reference' }], [{ assetId: 'managed-reference', role: 'model' }], null]) {
    assert.throws(() => catalog.compile({ recipeId: 'fixture', refs: invalid }), { code: 'INVALID_INPUT' });
  }
});

test('declared reference URLs and paths require an explicit complete managed mapping and are never opened', t => {
  const refImages = ['https://127.0.0.1:1/not-fetched.png', { path: '/does-not-exist/reference.png', label: 'Style' }];
  const { catalog } = fixture(t, makePreset({ refImages }));
  assert.equal(catalog.get('fixture').requiresReferenceMapping, true);
  assert.deepEqual(catalog.get('fixture').refImages, refImages);
  for (const refs of [undefined, [], [{ assetId: 'asset-one', role: 'reference' }]]) {
    assert.throws(() => catalog.compile({ recipeId: 'fixture', refs }), { code: 'REFERENCE_REQUIRED' });
  }
  const refs = [{ assetId: 'asset-one', role: 'identity' }, { assetId: 'asset-two', role: 'style' }];
  assert.deepEqual(catalog.compile({ recipeId: 'fixture', refs }).refs, refs);
});

test('queries cover nested content and summaries paginate without exposing full prompts', t => {
  const { catalog } = fixture(t);
  assert.equal(catalog.list({ q: 'flyaway' }).total, 1);
  assert.equal(catalog.list({ q: 'HAIR', category: 'hair' }).total, 1);
  assert.equal(catalog.list({ category: 'head' }).total, 0);
  assert.equal(Object.hasOwn(catalog.list().items[0], 'content'), false);
  const bundled = createRecipeCatalog(), page = bundled.list();
  assert.equal(page.items.length, 20); assert.equal(page.nextOffset, 20);
  assert.equal(bundled.list({ offset: page.nextOffset, limit: 1 }).items[0].recipeId, 'f_020');
  assert.deepEqual(bundled.list({ offset: 1000 }), { items: [], total: 121, nextOffset: null });
  assert.equal(bundled.list({ category: 'head', limit: 200 }).total, 23);
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 201 }, { q: 1 }, { extra: true }]) assert.throws(() => bundled.list(input), { code: 'INVALID_INPUT' });
});

test('catalog results are defensive copies and hashes include metadata in a stable process snapshot', t => {
  const preset = makePreset(), { catalog, rootDir, file } = fixture(t, preset);
  const first = catalog.get('fixture'), hash = first.sourceHash;
  first.parameters[0].defaultValue = 1; first.refImages.push('bad');
  const listed = catalog.list(); listed.items[0].title = 'bad';
  assert.equal(catalog.get('fixture').parameters[0].defaultValue, 0.5);
  assert.deepEqual(catalog.get('fixture').refImages, []); assert.equal(catalog.list().items[0].title, preset.title);
  fs.writeFileSync(file, JSON.stringify({ ...preset, title: 'Updated metadata' }));
  assert.equal(catalog.get('fixture').sourceHash, hash);
  assert.notEqual(createRecipeCatalog({ rootDir }).get('fixture').sourceHash, hash);
});

test('unrecognized IDs and traversal cannot address a filesystem path', t => {
  const { catalog } = fixture(t);
  for (const recipeId of ['../fixture', '/tmp/fixture', 'fixture.json/..', '']) assert.throws(() => catalog.get(recipeId), { code: 'INVALID_INPUT' });
  assert.throws(() => catalog.get('missing'), { code: 'RECIPE_NOT_FOUND', status: 404 });
});

test('corrupt catalogs fail explicitly instead of silently dropping a preset', t => {
  const rootDir = directory(t), file = path.join(rootDir, 'fixture.json');
  const invalid = [
    '{bad json', JSON.stringify(makePreset({ content: '{bad content' })),
    JSON.stringify(makePreset({ content: '[]' })), JSON.stringify(makePreset({ id: '../invalid' })),
    JSON.stringify(makePreset({ _isFactory: false })), JSON.stringify(makePreset({ refImages: null })),
    JSON.stringify(makePreset({ content: '{"@param:细节":"0.5"}' })),
    JSON.stringify(makePreset({ content: '{"@param:细节":2}' })),
    JSON.stringify(makePreset({ content: '{"@param:细节":0.5,"child":{"@param:细节":0.2}}' })),
    JSON.stringify(makePreset({ content: '{"__proto__":{"bad":true}}' })),
    ' '.repeat(256 * 1024 + 1),
  ];
  for (const bytes of invalid) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => createRecipeCatalog({ rootDir }), { code: 'RECIPE_CATALOG_INVALID' });
  }
  fs.writeFileSync(file, JSON.stringify(makePreset()));
  fs.writeFileSync(path.join(rootDir, 'duplicate.json'), JSON.stringify(makePreset()));
  assert.throws(() => createRecipeCatalog({ rootDir }), { code: 'RECIPE_CATALOG_INVALID' });
});

test('catalog does not follow symlinked JSON entries', t => {
  const rootDir = directory(t), outside = path.join(directory(t), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(makePreset()));
  fs.symlinkSync(outside, path.join(rootDir, 'linked.json'));
  assert.throws(() => createRecipeCatalog({ rootDir }), { code: 'RECIPE_CATALOG_INVALID' });
});
