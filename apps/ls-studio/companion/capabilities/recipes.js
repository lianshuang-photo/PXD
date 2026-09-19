'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DomainError, invariant, object, id, clone, validateSchema, contextSchema } = require('../domain/contracts');

const PREFIX = '@param:';
const MAX_PROMPT_LENGTH = 64000;
const INVALID_CATALOG = 'RECIPE_CATALOG_INVALID';
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const copy = value => JSON.parse(JSON.stringify(value));

function catalogCheck(condition, message) {
  invariant(condition, INVALID_CATALOG, message, 503);
}

function inspectJson(value, visit, parts = [], depth = 0) {
  catalogCheck(depth <= 32, 'Recipe nesting exceeds 32 levels');
  if (value === null || typeof value !== 'object') {
    catalogCheck(typeof value !== 'number' || Number.isFinite(value), 'Recipe contains a non-finite number');
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    catalogCheck(!unsafeKeys.has(key), 'Recipe contains an unsafe object key');
    visit(value, key, child, parts);
    inspectJson(child, visit, [...parts, key], depth + 1);
  }
}

function normalize(bytes) {
  let preset, body;
  try {
    preset = JSON.parse(bytes.toString('utf8'));
    catalogCheck(preset && typeof preset === 'object' && !Array.isArray(preset), 'Recipe must be an object');
    catalogCheck(preset._isFactory === true, 'Recipe is not a factory preset');
    id(preset.id, 'recipeId');
    catalogCheck(typeof preset.title === 'string' && preset.title.length > 0 && preset.title.length <= 1000, 'Recipe title is invalid');
    catalogCheck(typeof preset.category === 'string' && preset.category.length > 0 && preset.category.length <= 100, 'Recipe category is invalid');
    catalogCheck(preset.subCategory === undefined || (typeof preset.subCategory === 'string' && preset.subCategory.length <= 100), 'Recipe subcategory is invalid');
    catalogCheck(typeof preset.content === 'string' && preset.content.length > 0 && preset.content.length <= MAX_PROMPT_LENGTH, 'Recipe content is invalid or too long');
    catalogCheck(Array.isArray(preset.refImages) && preset.refImages.length <= 16, 'Recipe reference slots are invalid');
    body = JSON.parse(preset.content);
    catalogCheck(body && typeof body === 'object' && !Array.isArray(body), 'Recipe content must contain a JSON object');
    inspectJson(preset.refImages, () => {});
  } catch (error) {
    if (error.code === INVALID_CATALOG) throw error;
    throw new DomainError(INVALID_CATALOG, 'Recipe metadata or content is invalid', 503);
  }

  const parameters = [], bindings = [], parameterIds = new Set();
  inspectJson(body, (parent, key, value, parts) => {
    if (!key.startsWith(PREFIX) || key.endsWith('_desc')) return;
    const parameterId = key.slice(PREFIX.length);
    catalogCheck(parameterId.length > 0 && parameterId.length <= 200 && parameterId.trim() === parameterId && !parameterId.startsWith(PREFIX) && !unsafeKeys.has(parameterId), 'Recipe parameter ID is invalid');
    catalogCheck(!parameterIds.has(parameterId), 'Recipe parameter IDs must be unique throughout the content');
    catalogCheck(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Recipe parameters must be numbers between 0 and 1');
    const description = parent[key + '_desc'];
    catalogCheck(description === undefined || typeof description === 'string', 'Recipe parameter description must be text');
    parameterIds.add(parameterId);
    parameters.push({ id: parameterId, key, label: parameterId, defaultValue: value, min: 0, max: 1, step: 0.01, description: description || '' });
    bindings.push({ id: parameterId, path: [...parts, key] });
  });
  catalogCheck(parameters.length <= 32, 'Recipe contains more than 32 parameters');

  const recipe = {
    recipeId: preset.id, title: preset.title, category: preset.category, subCategory: preset.subCategory || '',
    content: preset.content, sourceHash: createHash('sha256').update(bytes).digest('hex'),
    parameters, refImages: preset.refImages, requiresReferenceMapping: preset.refImages.length > 0,
  };
  return { recipe, bindings, search: [recipe.title, recipe.category, recipe.subCategory, recipe.content].join('\n').toLocaleLowerCase() };
}

// rootDir is a trusted catalog directory, never a recipe ID or a reference path.
// Load once so a process uses one stable catalog snapshot and source hashes.
function createRecipeCatalog({ rootDir = path.join(__dirname, '..', 'factory_presets') } = {}) {
  invariant(typeof rootDir === 'string' && rootDir.length > 0, 'INVALID_INPUT', 'A recipe catalog directory is required');
  const entries = new Map();
  try {
    const files = fs.readdirSync(rootDir, { withFileTypes: true }).filter(entry => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    catalogCheck(files.length <= 1000, 'Recipe catalog contains too many files');
    let totalBytes = 0;
    for (const file of files) {
      catalogCheck(file.isFile(), 'Recipe catalog entries must be regular files');
      const filePath = path.join(rootDir, file.name), stat = fs.lstatSync(filePath);
      catalogCheck(stat.isFile() && stat.size <= 256 * 1024, 'Recipe file is invalid or too large');
      totalBytes += stat.size;
      catalogCheck(totalBytes <= 32 * 1024 * 1024, 'Recipe catalog exceeds 32 MiB');
      const bytes = fs.readFileSync(filePath);
      catalogCheck(bytes.length <= 256 * 1024, 'Recipe file is too large');
      const entry = normalize(bytes);
      catalogCheck(!entries.has(entry.recipe.recipeId), 'Recipe IDs must be unique');
      entries.set(entry.recipe.recipeId, entry);
    }
  } catch (error) {
    if (error.code === INVALID_CATALOG) throw error;
    throw new DomainError(INVALID_CATALOG, 'Recipe catalog could not be read', 503);
  }

  function lookup(recipeId) {
    id(recipeId, 'recipeId');
    const entry = entries.get(recipeId);
    invariant(entry, 'RECIPE_NOT_FOUND', 'Recipe was not found', 404);
    return entry;
  }

  function list(input = {}) {
    validateSchema(input, { type: 'object', properties: {
      q: { type: 'string', maxLength: 500 }, category: { type: 'string', maxLength: 100 },
      offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, additionalProperties: false }, 'recipes');
    const { q = '', category = '', offset = 0, limit = 20 } = input;
    const query = q.trim().toLocaleLowerCase();
    const matches = [...entries.values()].filter(entry => (!category || entry.recipe.category === category) && (!query || entry.search.includes(query)));
    const items = matches.slice(offset, offset + limit).map(({ recipe }) => ({
      recipeId: recipe.recipeId, title: recipe.title, category: recipe.category, subCategory: recipe.subCategory,
      sourceHash: recipe.sourceHash, parameterCount: recipe.parameters.length, referenceCount: recipe.refImages.length,
      requiresReferenceMapping: recipe.requiresReferenceMapping,
    }));
    return { items, total: matches.length, nextOffset: offset + items.length < matches.length ? offset + items.length : null };
  }

  function get(recipeId) { return copy(lookup(recipeId).recipe); }

  function compile({ recipeId, values = {}, userText = '', refs } = {}) {
    const { recipe, bindings } = lookup(recipeId);
    object(values, 'values');
    invariant(typeof userText === 'string' && userText.length <= MAX_PROMPT_LENGTH, 'INVALID_INPUT', 'Recipe instruction must be text of at most 64000 characters');
    const resolved = Object.fromEntries(recipe.parameters.map(parameter => [parameter.id, parameter.defaultValue]));
    const seen = new Set();
    for (const [key, value] of Object.entries(values)) {
      const parameterId = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
      invariant(Object.hasOwn(resolved, parameterId), 'INVALID_INPUT', 'Unknown recipe parameter: ' + key);
      invariant(!seen.has(parameterId), 'INVALID_INPUT', 'Duplicate recipe parameter alias: ' + parameterId);
      invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'INVALID_INPUT', 'Recipe parameter must be a number between 0 and 1: ' + parameterId);
      seen.add(parameterId); resolved[parameterId] = value;
    }
    if (refs !== undefined) validateSchema(refs, contextSchema.properties.refs, 'refs');
    invariant(!recipe.requiresReferenceMapping || (Array.isArray(refs) && refs.length === recipe.refImages.length), 'REFERENCE_REQUIRED', 'Map every recipe reference slot to an explicit managed asset in the same order');

    const body = JSON.parse(recipe.content);
    for (const binding of bindings) {
      let parent = body;
      for (const key of binding.path.slice(0, -1)) parent = parent[key];
      parent[binding.path[binding.path.length - 1]] = resolved[binding.id];
    }
    const prompt = JSON.stringify(body) + (userText.length ? '\n\n' + userText : '');
    invariant(prompt.length <= MAX_PROMPT_LENGTH, 'INVALID_INPUT', 'Compiled recipe and instruction exceed 64000 characters');
    return { prompt, recipe: { recipeId: recipe.recipeId, sourceHash: recipe.sourceHash, values: resolved }, ...(refs === undefined ? {} : { refs: clone(refs) }) };
  }

  return { list, get, compile };
}

module.exports = { createRecipeCatalog };
