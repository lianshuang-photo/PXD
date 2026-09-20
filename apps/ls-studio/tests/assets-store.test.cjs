const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createAssetStore } = require('../companion/assets');
const { inspectImage, MAX_PIXELS } = require('../companion/assets/image');

function crc(data) {
  let result = 0xffffffff;
  for (const byte of data) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}
function png(width = 2, height = 3, pixels) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels || Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
// Real 2×3 fixtures encoded once with Pillow. Runtime tests need only Node.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkqKKK+7PXP//Z', 'base64');
const webp = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vD6K/9g7/9Kx/6Vj9kj/cFJ6GyMAAAA', 'base64');
function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxd-assets-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, store: createAssetStore({ rootDir }) };
}
test('PNG/JPEG/WebP bytes determine dimensions and survive an independent store restart', t => {
  const { rootDir, store } = setup(t);
  for (const [data, mimeType] of [[png(), 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const asset = store.put({ data, mimeType, width: 2, height: 3, purpose: 'base', colorSpace: 'srgb', bitDepth: 8 });
    const restored = createAssetStore({ rootDir }).read(asset.assetId);
    assert.equal(asset.width, 2); assert.equal(asset.height, 3); assert.equal(asset.sizeBytes, data.length);
    assert.deepEqual(restored.asset, asset); assert.deepEqual(restored.data, data);
  }
});
test('asset bytes, metadata and reused content remain independent and immutable', t => {
  const { store } = setup(t), data = png(), original = Buffer.from(data), source = { documentId: 7, bounds: { left: 0 } };
  const first = store.put({ data, source, purpose: 'base' });
  const second = store.put({ data, source: { documentId: 8 }, purpose: 'mask' });
  source.bounds.left = 100; data.fill(0); first.source.documentId = 99;
  const loaded = store.read(first.assetId); loaded.data.fill(0); loaded.asset.source.bounds.left = -1;
  assert.equal(store.get(first.assetId).source.documentId, 7);
  assert.equal(store.get(first.assetId).source.bounds.left, 0);
  assert.deepEqual(store.read(first.assetId).data, original);
  assert.equal(second.sha256, first.sha256); assert.notEqual(second.assetId, first.assetId);
  assert.equal(store.get(second.assetId).purpose, 'mask');
});
test('format lies, dimension lies, truncated chunks and invalid compressed pixels fail before persistence', t => {
  const { store, rootDir } = setup(t), valid = png();
  assert.throws(() => store.put({ data: valid, mimeType: 'image/jpeg' }), { code: 'IMAGE_METADATA_MISMATCH' });
  assert.throws(() => store.put({ data: valid, width: 999 }), { code: 'IMAGE_METADATA_MISMATCH' });
  assert.throws(() => store.put({ data: valid, bitDepth: 16 }), { code: 'IMAGE_METADATA_MISMATCH' });
  assert.throws(() => store.put({ data: Buffer.from('<svg />') }), { code: 'UNSUPPORTED_IMAGE' });
  assert.throws(() => store.put({ data: valid.subarray(0, -1) }), { code: 'INVALID_IMAGE' });
  assert.throws(() => store.put({ data: png(2, 3, Buffer.alloc(2)) }), { code: 'INVALID_IMAGE' });
  assert.throws(() => store.put({ data: png(1, 1, Buffer.alloc(1024 * 1024)) }), { code: 'INVALID_IMAGE' });
  const badCrc = Buffer.from(valid); badCrc[20] ^= 1;
  assert.throws(() => store.put({ data: badCrc }), { code: 'INVALID_IMAGE' });
  assert.equal(fs.readdirSync(path.join(rootDir, 'objects')).length, 0);
});
test('pixel bounds apply before decompression and formats cannot have trailing payloads', () => {
  assert.ok(MAX_PIXELS >= 8000000);
  assert.throws(() => inspectImage(png(32768, 32768, Buffer.alloc(4))), { code: 'IMAGE_TOO_LARGE' });
  for (const image of [png(), jpeg, webp]) {
    assert.throws(() => inspectImage(Buffer.concat([image, Buffer.from('extra')])));
    assert.throws(() => inspectImage(image.subarray(0, image.length - 4)));
  }
});
test('publication failure never returns a nonexistent asset and restart ignores unpublished crash residue', t => {
  const { rootDir, store } = setup(t), originalRename = fs.renameSync;
  fs.renameSync = (...args) => { if (String(args[0]).includes(path.join('objects', '.tmp-'))) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); return originalRename(...args); };
  try { assert.throws(() => store.put({ data: png() }), { code: 'STORAGE_UNAVAILABLE' }); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readdirSync(path.join(rootDir, 'objects')), []);
  const orphan = path.join(rootDir, 'objects', '.tmp-crashed'); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'image'), png());
  const restarted = createAssetStore({ rootDir }), good = restarted.put({ data: png() });
  assert.deepEqual(restarted.read(good.assetId).data, png());
  assert.throws(() => restarted.get('.tmp-crashed'), { code: 'INVALID_INPUT' });
});
test('tampered bytes, tampered metadata and missing files fail closed', t => {
  const { rootDir, store } = setup(t);
  const locate = (asset, name) => path.join(rootDir, 'objects', asset.assetId, name);
  const bytes = store.put({ data: png() }); fs.appendFileSync(locate(bytes, 'image'), 'tamper');
  assert.throws(() => store.get(bytes.assetId), { code: 'ASSET_INTEGRITY' });
  const meta = store.put({ data: png() }), manifestFile = locate(meta, 'asset.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.asset.purpose = 'changed'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => store.get(meta.assetId), { code: 'ASSET_INTEGRITY' });
  const missing = store.put({ data: png() }); fs.unlinkSync(locate(missing, 'image'));
  assert.throws(() => store.get(missing.assetId), { code: 'ASSET_INTEGRITY' });
  assert.throws(() => store.get('../outside.png'), { code: 'INVALID_INPUT' });
});
test('managed image files cannot redirect reads through symlinks', { skip: process.platform === 'win32' ? 'Windows symlink creation requires separate operator privileges' : false }, t => {
  const { rootDir, store } = setup(t), asset = store.put({ data: png() });
  const file = path.join(rootDir, 'objects', asset.assetId, 'image'), target = path.join(rootDir, 'outside.png');
  fs.writeFileSync(target, png()); fs.unlinkSync(file); fs.symlinkSync(target, file);
  assert.throws(() => store.get(asset.assetId), { code: 'ASSET_INTEGRITY' });
});
test('Windows publication flushes files without attempting unsupported directory handles', t => {
  const { rootDir } = setup(t), platform = Object.getOwnPropertyDescriptor(process, 'platform'), open = fs.openSync;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.openSync = (file, ...args) => {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw Object.assign(new Error('Windows directory handles are not exposed by Node'), { code: 'EPERM' });
    return open(file, ...args);
  };
  try {
    const store = createAssetStore({ rootDir }), asset = store.put({ data: png() });
    assert.deepEqual(store.read(asset.assetId).data, png());
  } finally { fs.openSync = open; Object.defineProperty(process, 'platform', platform); }
});
test('binary or credential metadata never enters the managed asset manifest', t => {
  const { store } = setup(t);
  assert.throws(() => store.put({ data: png(), source: { apiKey: 'fixture-only' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.put({ data: png(), source: { nested: { base64: 'AAAA' } } }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.put({ data: png(), path: '../../anything' }), { code: 'INVALID_INPUT' });
});
