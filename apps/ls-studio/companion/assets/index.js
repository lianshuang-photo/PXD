'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DomainError, invariant, clone, object } = require('../domain/contracts');
const { inspectImage, MAX_BYTES } = require('./image');
const digest = value => createHash('sha256').update(value).digest('hex');
const assetIdPattern = /^asset-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const metadataLimit = 128 * 1024;

function syncDirectory(directory) {
  // Node cannot open directory handles for fsync on Windows. File contents are
  // still flushed before rename; POSIX additionally flushes the parent entry.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeDurable(file, contents) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function safeMetadata(value) {
  const copied = clone(value);
  function check(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      invariant(!/^(base64|dataurl|bytes|buffer|credentials?|token|key|api[_-]?key|secret[_-]?key)$/i.test(key), 'INVALID_INPUT', 'Asset metadata cannot contain image bytes or credentials');
      check(child);
    }
  }
  check(copied);
  invariant(Buffer.byteLength(JSON.stringify(copied)) <= metadataLimit, 'INVALID_INPUT', 'Asset metadata is too large');
  return copied;
}
function smallText(value, field, maximum = 128) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= maximum, 'INVALID_INPUT', field + ' is invalid');
  return value;
}
function createAssetStore({ rootDir } = {}) {
  invariant(typeof rootDir === 'string' && rootDir.trim(), 'INVALID_INPUT', 'An asset directory is required');
  let directory;
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    directory = path.join(fs.realpathSync(rootDir), 'objects');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    invariant(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'STORAGE_CORRUPT', 'Asset object storage must be a directory', 500);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('STORAGE_UNAVAILABLE', 'Cannot open asset storage', 503);
  }
  function read(assetId) {
    invariant(typeof assetId === 'string' && assetIdPattern.test(assetId), 'INVALID_INPUT', 'Asset ID is invalid');
    const location = path.join(directory, assetId);
    let payload, data;
    try {
      const locationStat = fs.lstatSync(location);
      invariant(locationStat.isDirectory() && !locationStat.isSymbolicLink(), 'ASSET_INTEGRITY', 'Stored asset directory is invalid', 500);
      const manifestFile = path.join(location, 'asset.json'), dataFile = path.join(location, 'image');
      for (const [file, maximum] of [[manifestFile, metadataLimit * 2], [dataFile, MAX_BYTES]]) {
        const stat = fs.lstatSync(file);
        invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'ASSET_INTEGRITY', 'Stored asset file is invalid', 500);
      }
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      invariant(manifest.schemaVersion === 1 && typeof manifest.checksum === 'string' && manifest.checksum === digest(JSON.stringify(manifest.asset)), 'ASSET_INTEGRITY', 'Stored asset metadata failed its integrity check', 500);
      payload = safeMetadata(manifest.asset); object(payload);
      invariant(payload.assetId === assetId && /^[a-f0-9]{64}$/.test(payload.sha256) && typeof payload.createdAt === 'string' && Number.isFinite(Date.parse(payload.createdAt)), 'ASSET_INTEGRITY', 'Stored asset metadata is invalid', 500);
      smallText(payload.purpose, 'purpose'); smallText(payload.colorSpace, 'colorSpace');
      data = fs.readFileSync(dataFile);
      invariant(data.length === payload.sizeBytes && digest(data) === payload.sha256, 'ASSET_INTEGRITY', 'Stored asset bytes failed their integrity check', 500);
      const actual = inspectImage(data);
      invariant(['width', 'height', 'bitDepth', 'mimeType'].every(key => actual[key] === payload[key]), 'ASSET_INTEGRITY', 'Stored asset dimensions or format have changed', 500);
    } catch (error) {
      if (error && error.code === 'ENOENT' && !fs.existsSync(location)) throw new DomainError('ASSET_NOT_FOUND', 'Asset was not found', 404);
      if (error instanceof DomainError && error.code === 'ASSET_INTEGRITY') throw error;
      throw new DomainError('ASSET_INTEGRITY', 'Stored asset is missing, corrupt or unreadable', 500);
    }
    return { asset: clone(payload), data };
  }
  function put(input) {
    object(input);
    for (const field of Object.keys(input)) invariant(['data', 'mimeType', 'purpose', 'width', 'height', 'colorSpace', 'bitDepth', 'source'].includes(field), 'INVALID_INPUT', 'Unsupported asset field: ' + field);
    // Copy before examining or writing: callers retain no mutable reference to the
    // bytes that will be advertised as this immutable asset.
    invariant(Buffer.isBuffer(input.data), 'INVALID_IMAGE', 'Image data must be a Buffer');
    invariant(input.data.length <= MAX_BYTES, 'IMAGE_TOO_LARGE', 'Image bytes exceed the production input limit');
    const data = Buffer.from(input.data), actual = inspectImage(data);
    for (const field of ['mimeType', 'width', 'height', 'bitDepth']) if (input[field] !== undefined) invariant(input[field] === actual[field], 'IMAGE_METADATA_MISMATCH', 'Declared ' + field + ' does not match the image');
    const asset = {
      assetId: 'asset-' + randomUUID(), sha256: digest(data), ...actual,
      purpose: input.purpose === undefined ? 'source' : smallText(input.purpose, 'purpose'),
      sizeBytes: data.length, colorSpace: input.colorSpace === undefined ? 'unknown' : smallText(input.colorSpace, 'colorSpace'),
      createdAt: new Date().toISOString(),
      ...(input.source === undefined ? {} : { source: safeMetadata(input.source) }),
    };
    const manifest = JSON.stringify({ schemaVersion: 1, checksum: digest(JSON.stringify(asset)), asset });
    const temporary = path.join(directory, '.tmp-' + randomUUID()), destination = path.join(directory, asset.assetId);
    try {
      fs.mkdirSync(temporary, { mode: 0o700 });
      writeDurable(path.join(temporary, 'image'), data);
      writeDurable(path.join(temporary, 'asset.json'), manifest);
      syncDirectory(temporary);
      invariant(!fs.existsSync(destination), 'STORAGE_UNAVAILABLE', 'Asset ID collision', 503);
      fs.renameSync(temporary, destination);
      syncDirectory(directory);
    } catch (error) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) { /* unpublished leftovers are never read */ }
      if (error instanceof DomainError) throw error;
      throw new DomainError('STORAGE_UNAVAILABLE', 'Unable to persist the image asset', 503);
    }
    return clone(asset);
  }
  return { put, get: assetId => read(assetId).asset, read };
}
module.exports = { createAssetStore };
