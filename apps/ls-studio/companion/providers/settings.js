'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DomainError, invariant, object } = require('../domain/contracts');
const { createGeminiProvider, configuration } = require('./index');

const variables = { apiKey: 'PXDLS_GEMINI_API_KEY', baseUrl: 'PXDLS_GEMINI_BASE_URL', model: 'PXDLS_GEMINI_MODEL', timeoutMs: 'PXDLS_GEMINI_TIMEOUT_MS' };
const defaults = { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image', timeoutMs: 180000 };
const MAX_BYTES = 16 * 1024;
const has = (value, key) => Object.hasOwn(value, key);
function fields(value, names) {
  object(value, 'configuration');
  invariant(Object.keys(value).every(key => names.includes(key)), 'INVALID_INPUT', 'Unsupported provider configuration field');
}
function checked(values) {
  fields(values, Object.keys(variables));
  // Use exactly the transport's validation, even when no key has been entered.
  // Never include a rejected value in an error or in public task metadata.
  try { configuration({}, values, { allowMissingKey: true }); }
  catch (_) { throw new DomainError('INVALID_CONFIGURATION', 'Use an HTTPS Gemini API root, a valid model, a plain API key and a timeout of 1–600000 ms'); }
  return values;
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// This dedicated directory contains a write-only secret. It is never an asset,
// draft, MCP result, browser storage entry or diagnostic payload.
function createProviderSettings({ rootDir, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  invariant(typeof rootDir === 'string' && rootDir.length > 0, 'INVALID_INPUT', 'A private provider configuration directory is required');
  let directory;
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    if (process.platform !== 'win32') fs.chmodSync(rootDir, 0o700);
    directory = fs.realpathSync(rootDir);
  } catch (_) { throw new DomainError('CONFIG_STORAGE_UNAVAILABLE', 'Cannot open private provider configuration storage', 503); }
  const file = path.join(directory, 'gemini.json');
  function load() {
    let fd;
    try {
      const entry = fs.lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > MAX_BYTES) throw new Error();
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      fields(state, ['schemaVersion', 'revision', 'values']);
      if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error();
      checked(state.values); return state;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A dangling link must not be treated as a fresh configuration file.
        try { fs.lstatSync(file); } catch (missing) { if (missing.code === 'ENOENT') return { schemaVersion: 1, revision: 0, values: {} }; }
      }
      throw new DomainError('CONFIG_STORAGE_CORRUPT', 'Provider configuration is unreadable or invalid; it was not replaced', 503);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function effective(state) {
    const values = {}, sources = {};
    for (const [key, variable] of Object.entries(variables)) {
      const fromEnv = env[variable] !== undefined;
      values[key] = fromEnv ? env[variable] : has(state.values, key) ? state.values[key] : defaults[key];
      sources[key] = fromEnv ? 'environment' : has(state.values, key) ? 'local' : 'default';
    }
    return { values, sources };
  }
  function describeState(state) {
    const { values, sources } = effective(state);
    const adapter = createGeminiProvider({ env: {}, config: values, fetchImpl });
    const provider = adapter.describe();
    let publicValues;
    try {
      const normalized = configuration({}, values, { allowMissingKey: true });
      publicValues = { baseUrl: normalized.apiRoot, model: normalized.model, timeoutMs: normalized.timeoutMs };
    } catch (_) {
      // Invalid environment settings might themselves contain credentials.
      // Report the fixed validation error, never echo their raw values.
      publicValues = { baseUrl: '', model: '', timeoutMs: defaults.timeoutMs };
    }
    return { revision: state.revision, ...publicValues, sources, environmentOverrides: Object.keys(variables).filter(key => sources[key] === 'environment'), hasApiKey: typeof values.apiKey === 'string' && values.apiKey.trim().length > 0, hasLocalApiKey: Boolean(state.values.apiKey), configured: provider.configured, provider, ...(provider.configurationError ? { configurationError: provider.configurationError } : {}), precedence: 'environment > local > default' };
  }
  function read() { return describeState(load()); }
  function update(input) {
    fields(input, ['expectedRevision', 'baseUrl', 'model', 'timeoutMs', 'apiKey', 'clearApiKey']);
    invariant(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'INVALID_INPUT', 'expectedRevision must be a nonnegative integer');
    invariant(input.clearApiKey === undefined || typeof input.clearApiKey === 'boolean', 'INVALID_INPUT', 'clearApiKey must be boolean');
    invariant(!(has(input, 'apiKey') && input.clearApiKey), 'INVALID_INPUT', 'Set or clear the local API key in separate requests');
    const state = load();
    invariant(input.expectedRevision === state.revision, 'CONFIG_REVISION_CONFLICT', 'Provider settings changed; reload before saving', 409);
    const values = { ...state.values };
    for (const [key, variable] of Object.entries(variables)) {
      if (!has(input, key)) continue;
      invariant(env[variable] === undefined, 'CONFIG_OVERRIDDEN', 'An environment variable controls this setting; update the Companion environment to change it', 409);
      if (key === 'apiKey') invariant(typeof input[key] === 'string' && input[key].trim().length > 0, 'INVALID_INPUT', 'Use clearApiKey to delete a saved key');
      values[key] = typeof input[key] === 'string' ? input[key].trim() : input[key];
    }
    if (input.clearApiKey) delete values.apiKey;
    checked(values);
    invariant(state.revision < Number.MAX_SAFE_INTEGER, 'STATE_CONFLICT', 'Configuration revision limit reached', 409);
    const next = { schemaVersion: 1, revision: state.revision + 1, values };
    const serialized = JSON.stringify(next);
    invariant(Buffer.byteLength(serialized) <= MAX_BYTES, 'INVALID_CONFIGURATION', 'Provider configuration exceeds its size limit');
    const temporary = path.join(directory, '.gemini-' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file); syncDirectory(directory);
    } catch (_) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      throw new DomainError('CONFIG_STORAGE_UNAVAILABLE', 'Unable to save private provider configuration', 503);
    }
    return describeState(next);
  }
  function snapshot() { return createGeminiProvider({ env: {}, config: effective(load()).values, fetchImpl }); }
  return { read, update, snapshot, describe: input => snapshot().describe(input) };
}

module.exports = { createProviderSettings };
