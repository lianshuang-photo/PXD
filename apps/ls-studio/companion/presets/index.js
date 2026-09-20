'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DomainError, invariant, object, clone, id } = require('../domain/contracts');
const { normalizeRecipe, compileRecipe } = require('../capabilities/recipes');
const MAX_FILE = 32 * 1024 * 1024, MAX_DEFINITION = 256 * 1024;
const roles = ['reference', 'identity', 'style', 'structure'];
const hash = text => createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fields(value, allowed) {
  object(value); clone(value);
  invariant(Object.keys(value).every(key => allowed.includes(key)), 'INVALID_RECIPE', 'Unsupported preset field');
}
function definition(input) {
  fields(input, ['title', 'category', 'subCategory', 'content', 'refImages']);
  const value = { title: input.title, category: input.category, subCategory: input.subCategory === undefined ? '' : input.subCategory, content: input.content, refImages: input.refImages === undefined ? [] : input.refImages };
  invariant(typeof value.title === 'string' && value.title.trim() && typeof value.category === 'string' && value.category.trim(), 'INVALID_RECIPE', 'Preset title and category must not be blank');
  invariant(Array.isArray(value.refImages) && value.refImages.length <= 16, 'INVALID_RECIPE', 'At most 16 reference slots are supported');
  const slots = new Set();
  for (const slot of value.refImages) {
    fields(slot, ['slotId', 'label', 'role']); id(slot.slotId, 'slotId');
    invariant(!slots.has(slot.slotId) && typeof slot.label === 'string' && slot.label.trim() && slot.label.length <= 200 && roles.includes(slot.role), 'INVALID_RECIPE', 'Reference slots need unique IDs, labels and supported roles');
    slots.add(slot.slotId);
  }
  invariant(Buffer.byteLength(JSON.stringify(value)) <= MAX_DEFINITION, 'INVALID_RECIPE', 'Preset definition exceeds 256 KiB');
  normalized('user-validation', value); return clone(value);
}
function normalized(recipeId, value) {
  try { return normalizeRecipe(Buffer.from(canonical({ id: recipeId, ...value, _isFactory: false })), { factory: false }); }
  catch (error) { throw new DomainError('INVALID_RECIPE', error.message || 'Preset definition is invalid'); }
}
function source(value) { invariant(['ui', 'agent', 'system'].includes(value), 'INVALID_INPUT', 'Unknown preset update source'); return value; }
function flush(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durable(file, bytes) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

// One Companion owns this directory. Factory files and job snapshots are never written.
function createRecipeLibrary({ rootDir, factoryCatalog }) {
  invariant(typeof rootDir === 'string' && rootDir && factoryCatalog, 'INVALID_INPUT', 'User preset storage and factory catalog are required');
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(rootDir), file = path.join(directory, 'presets.json'), marker = path.join(directory, '.initialized');
  function validateState(state) {
    fields(state, ['schemaVersion', 'recipes', 'requests']);
    invariant(state.schemaVersion === 1 && Array.isArray(state.recipes) && state.recipes.length <= 1000 && Array.isArray(state.requests), 'INVALID_RECIPE', 'Invalid preset state');
    const ids = new Set(), requests = new Set();
    for (const entry of state.recipes) {
      fields(entry, ['recipeId', 'versions']);
      invariant(/^user-[0-9a-f-]{36}$/.test(entry.recipeId) && !ids.has(entry.recipeId) && Array.isArray(entry.versions) && entry.versions.length && entry.versions.length <= 500, 'INVALID_RECIPE', 'Invalid preset history');
      ids.add(entry.recipeId);
      entry.versions.forEach((version, index) => {
        fields(version, ['revision', 'definition', 'sourceHash', 'archived', 'action', 'source', 'createdAt', 'origin']);
        invariant(version.revision === index + 1 && typeof version.archived === 'boolean' && ['create', 'copy', 'import', 'update', 'archive', 'restore'].includes(version.action) && Number.isFinite(Date.parse(version.createdAt)), 'INVALID_RECIPE', 'Invalid preset version');
        source(version.source); definition(version.definition);
        invariant(normalized(entry.recipeId, version.definition).recipe.sourceHash === version.sourceHash, 'INVALID_RECIPE', 'Preset version hash mismatch');
        if (version.origin) { fields(version.origin, ['recipeId', 'sourceHash']); id(version.origin.recipeId); invariant(/^[a-f0-9]{64}$/.test(version.origin.sourceHash), 'INVALID_RECIPE', 'Invalid copied preset origin'); }
      });
    }
    for (const request of state.requests) {
      fields(request, ['requestId', 'signature', 'recipeId']); id(request.requestId);
      invariant(!requests.has(request.requestId) && /^[a-f0-9]{64}$/.test(request.signature) && ids.has(request.recipeId), 'INVALID_RECIPE', 'Invalid preset request ledger'); requests.add(request.requestId);
    }
    return state;
  }
  function write(state) {
    validateState(state);
    const data = JSON.stringify({ schemaVersion: 1, checksum: hash(JSON.stringify(state)), state });
    invariant(Buffer.byteLength(data) <= MAX_FILE, 'STORAGE_FULL', 'Preset history reached its 32 MiB limit', 507);
    const temporary = path.join(directory, '.presets-' + randomUUID() + '.tmp');
    try { durable(temporary, data); fs.renameSync(temporary, file); flush(directory); }
    catch (_) { try { fs.rmSync(temporary, { force: true }); } catch (_) {} throw new DomainError('STORAGE_UNAVAILABLE', 'Cannot persist user presets', 503); }
  }
  function read() {
    try {
      const stat = fs.lstatSync(file);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_FILE, 'INVALID_RECIPE', 'Invalid preset store');
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      invariant(envelope.schemaVersion === 1 && envelope.checksum === hash(JSON.stringify(envelope.state)), 'INVALID_RECIPE', 'Invalid preset checksum');
      return validateState(envelope.state);
    } catch (_) { throw new DomainError('STORAGE_CORRUPT', 'User preset storage is missing or corrupt; factory data and existing tasks were not changed', 500); }
  }
  if (!fs.existsSync(file)) {
    invariant(!fs.existsSync(marker), 'STORAGE_CORRUPT', 'Initialized user preset storage is missing', 500);
    durable(marker, 'ls-studio-presets-v1\n'); flush(directory); write({ schemaVersion: 1, recipes: [], requests: [] });
  } else { read(); if (!fs.existsSync(marker)) { durable(marker, 'ls-studio-presets-v1\n'); flush(directory); } }
  function user(state, recipeId) { id(recipeId, 'recipeId'); const entry = state.recipes.find(item => item.recipeId === recipeId); invariant(entry, 'RECIPE_READ_ONLY', 'Only an existing user preset can be changed; copy a factory preset first', 409); return entry; }
  function view(entry, revision) {
    const version = revision === undefined ? entry.versions[entry.versions.length - 1] : entry.versions.find(item => item.revision === revision);
    invariant(version, 'RECIPE_VERSION_NOT_FOUND', 'Preset version was not found', 404);
    return { ...normalized(entry.recipeId, version.definition).recipe, kind: 'user', revision: version.revision, archived: version.archived, source: version.source, updatedAt: version.createdAt, ...(version.origin ? { origin: clone(version.origin) } : {}) };
  }
  function get(recipeId, revision) {
    id(recipeId, 'recipeId'); if (revision !== undefined) invariant(Number.isSafeInteger(revision) && revision > 0, 'INVALID_INPUT', 'Preset revision is invalid');
    const entry = read().recipes.find(item => item.recipeId === recipeId);
    if (entry) return view(entry, revision);
    invariant(revision === undefined || revision === 1, 'RECIPE_VERSION_NOT_FOUND', 'Factory preset has one bundled version', 404);
    return { ...factoryCatalog.get(recipeId), kind: 'factory', revision: 1, archived: false };
  }
  function expect(entry, expectedRevision) {
    invariant(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 'INVALID_INPUT', 'expectedRevision is required');
    invariant(entry.versions.length === expectedRevision, 'RECIPE_REVISION_CONFLICT', 'Preset changed; reload it before saving or restoring', 409, { current: view(entry) });
  }
  function addVersion(entry, value, action, from, archived = false, origin) {
    invariant(entry.versions.length < 500, 'STORAGE_FULL', 'Preset reached its 500-version history limit', 507);
    const checked = definition(value);
    entry.versions.push({ revision: entry.versions.length + 1, definition: checked, sourceHash: normalized(entry.recipeId, checked).recipe.sourceHash, archived, action, source: source(from), createdAt: new Date().toISOString(), ...(origin ? { origin: clone(origin) } : {}) });
  }
  function create(input, action = 'create', origin) {
    const value = definition(input.definition); id(input.requestId, 'requestId'); source(input.source);
    const signature = hash(canonical({ action, definition: value, ...(origin ? { origin } : {}) })), state = read();
    const previous = state.requests.find(item => item.requestId === input.requestId);
    if (previous) { invariant(previous.signature === signature, 'REQUEST_CONFLICT', 'Preset request ID was already used with different content', 409); return view(user(state, previous.recipeId)); }
    invariant(state.recipes.length < 1000, 'STORAGE_FULL', 'User preset library reached its 1000-preset limit', 507);
    const entry = { recipeId: 'user-' + randomUUID(), versions: [] }; addVersion(entry, value, action, input.source, false, origin);
    state.recipes.push(entry); state.requests.push({ requestId: input.requestId, signature, recipeId: entry.recipeId }); write(state); return view(entry);
  }
  function copy(input) {
    const original = get(input.recipeId, input.revision);
    invariant(input.expectedSourceHash === original.sourceHash, 'RECIPE_REVISION_CONFLICT', 'Source preset changed; read its current definition before copying', 409, { current: original });
    const slots = original.refImages.map((slot, index) => ({ slotId: slot && slot.slotId || 'reference-' + (index + 1), label: slot && slot.label || '参考 ' + (index + 1), role: slot && roles.includes(slot.role) ? slot.role : 'reference' }));
    return create({ definition: { title: input.title === undefined ? original.title + ' 副本' : input.title, category: original.category, subCategory: original.subCategory, content: original.content, refImages: slots }, requestId: input.requestId, source: input.source }, 'copy', { recipeId: original.recipeId, sourceHash: original.sourceHash });
  }
  function change(input, action) {
    const state = read(), entry = user(state, input.recipeId); expect(entry, input.expectedRevision);
    const current = entry.versions[entry.versions.length - 1];
    if (action === 'update') invariant(!current.archived, 'RECIPE_ARCHIVED', 'Restore this preset before editing it', 409);
    let target = current;
    if (action === 'restore' && input.targetRevision !== undefined) {
      invariant(Number.isSafeInteger(input.targetRevision) && input.targetRevision > 0, 'INVALID_INPUT', 'Restore revision is invalid');
      target = entry.versions.find(item => item.revision === input.targetRevision);
      invariant(target, 'RECIPE_VERSION_NOT_FOUND', 'Restore revision was not found', 404);
    }
    addVersion(entry, action === 'update' ? input.definition : target.definition, action, input.source, action === 'archive', target.origin);
    write(state); return view(entry);
  }
  function list(input = {}) {
    fields(input, ['q', 'category', 'kind', 'includeArchived', 'offset', 'limit']);
    const { q = '', category = '', kind = 'all', includeArchived = false, offset = 0, limit = 20 } = input;
    invariant(typeof q === 'string' && q.length <= 500 && typeof category === 'string' && category.length <= 100 && ['all', 'factory', 'user'].includes(kind) && typeof includeArchived === 'boolean' && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'INVALID_INPUT', 'Invalid preset query');
    const users = read().recipes.map(entry => view(entry));
    const factories = []; if (kind !== 'user') { let next = 0; do { const page = factoryCatalog.list({ limit: 200, offset: next }); page.items.forEach(item => factories.push({ ...factoryCatalog.get(item.recipeId), kind: 'factory', revision: 1, archived: false })); next = page.nextOffset; } while (next !== null); }
    const query = q.trim().toLocaleLowerCase();
    const matches = [...(kind === 'factory' ? [] : users), ...factories].filter(item => (includeArchived || !item.archived) && (!category || item.category === category) && (!query || [item.title, item.category, item.subCategory, item.content].join('\n').toLocaleLowerCase().includes(query)));
    return { items: matches.slice(offset, offset + limit).map(item => ({ recipeId: item.recipeId, title: item.title, category: item.category, subCategory: item.subCategory, sourceHash: item.sourceHash, parameterCount: item.parameters.length, referenceCount: item.refImages.length, requiresReferenceMapping: item.requiresReferenceMapping, kind: item.kind, revision: item.revision, archived: item.archived })), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null };
  }
  function compile(input) {
    const recipe = get(input.recipeId);
    invariant(!recipe.archived, 'RECIPE_ARCHIVED', 'Restore this preset before loading it', 409);
    invariant((recipe.kind !== 'user' && input.expectedSourceHash === undefined) || input.expectedSourceHash === recipe.sourceHash, 'RECIPE_REVISION_CONFLICT', 'Preset changed; read it again before loading', 409, { current: recipe });
    if (recipe.kind === 'factory') return factoryCatalog.compile(input);
    if (recipe.refImages.length) invariant(Array.isArray(input.refs) && input.refs.length === recipe.refImages.length && input.refs.every((ref, index) => ref.role === recipe.refImages[index].role), 'REFERENCE_REQUIRED', 'Map each preset reference slot to a managed asset with the declared role');
    return compileRecipe(normalized(recipe.recipeId, definition({ title: recipe.title, category: recipe.category, subCategory: recipe.subCategory, content: recipe.content, refImages: recipe.refImages })), input);
  }
  return {
    list, get, compile, create, copy,
    update: input => change(input, 'update'), archive: input => change(input, 'archive'), restore: input => change(input, 'restore'),
    versions({ recipeId }) { const state = read(), entry = state.recipes.find(item => item.recipeId === recipeId); if (!entry) { const recipe = get(recipeId); return [{ revision: 1, sourceHash: recipe.sourceHash, title: recipe.title, action: 'factory', archived: false }]; } return entry.versions.slice().reverse().map(value => ({ revision: value.revision, sourceHash: value.sourceHash, title: value.definition.title, action: value.action, archived: value.archived, source: value.source, createdAt: value.createdAt })); },
    export({ recipeId, revision }) { const value = get(recipeId, revision); return { schemaVersion: 1, format: 'ls-studio-preset', definition: { title: value.title, category: value.category, subCategory: value.subCategory, content: value.content, refImages: value.refImages.map((slot, index) => ({ slotId: slot && slot.slotId || 'reference-' + (index + 1), label: slot && slot.label || '参考 ' + (index + 1), role: slot && roles.includes(slot.role) ? slot.role : 'reference' })) } }; },
    import(input) { fields(input.bundle, ['schemaVersion', 'format', 'definition']); invariant(input.bundle.schemaVersion === 1 && input.bundle.format === 'ls-studio-preset', 'INVALID_RECIPE', 'Unsupported preset import format'); return create({ definition: input.bundle.definition, requestId: input.requestId, source: input.source }, 'import'); },
  };
}
module.exports = { createRecipeLibrary, validateDefinition: definition };
