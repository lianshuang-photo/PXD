const test = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { createExecutor } = require('../plugin/ps-agent-014');
const codec = require('../plugin/ps-encode-014');
const pixels = require('../plugin/ps-pixels-014');

function readPNG(base64) {
  const bytes = Buffer.from(base64, 'base64'), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const components = ({ 0: 1, 2: 3, 6: 4 })[bytes[25]], chunks = [];
  for (let p = 8; p < bytes.length;) {
    const length = bytes.readUInt32BE(p), name = bytes.toString('ascii', p + 4, p + 8);
    if (name === 'IDAT') chunks.push(bytes.subarray(p + 8, p + 8 + length));
    p += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), samples = [];
  for (let y = 0; y < height; y++) {
    const row = y * (width * components + 1); assert.equal(raw[row], 0);
    samples.push(...raw.subarray(row + 1, row + 1 + width * components));
  }
  return { width, height, components, samples };
}
function fixture(options = {}) {
  const original = { id: 2, name: 'Original layer', visible: true, opacity: 80, kind: 'pixel' };
  const doc = { id: 1, name: 'sample.psd', width: 8, height: 6, bitsPerChannel: 16, mode: 'RGB', selection: { bounds: { left: 2, top: 1, right: 6, bottom: 4 } }, layers: [original], activeLayers: [original], activeHistoryState: { id: 10 } };
  const f = { doc, original, commands: [], imageReads: [], maskReads: [], disposed: 0, maskDisposed: 0, files: [], notifications: null, suspensions: [], resumes: [], maskSamples: [0, 32, 64, 0, 255, 0, 128, 255, 0, 192, 255, 0], imageSamples: null, onCommand: null, onModal: null, onPixels: null, failCommand: null, failMask: false, failResume: false, currentContext: null };
  let historyCounter = 10, layerCounter = 100, tokenCounter = 0, snapshot = null;
  const fs = {
    getTemporaryFolder: async () => ({ createFile: async name => { const file = { name, bytes: null, deleted: false, write: async data => { file.bytes = new Uint8Array(data).slice(); }, delete: async () => { file.deleted = true; } }; f.files.push(file); return file; } }),
    createSessionToken: async file => { file.token = 'token-' + ++tokenCounter; return file.token; }
  };
  const ps = {
    app: { documents: [doc], activeDocument: doc },
    core: { executeAsModal: async fn => {
      if (f.onModal) await f.onModal();
      const context = { isCancelled: false, hostControl: {
        suspendHistory: async input => { assert.equal(input.documentID, doc.id); snapshot = { layers: structuredClone(doc.layers), active: doc.activeLayers.map(l => l.id), history: doc.activeHistoryState.id }; f.suspensions.push(input); return 'suspension-' + f.suspensions.length; },
        resumeHistory: async (id, commit) => {
          f.resumes.push({ id, commit }); if (f.failResume) throw Error('native history API failed');
          if (commit) { doc.activeHistoryState = { id: ++historyCounter }; }
          else { doc.layers = snapshot.layers; doc.activeLayers = snapshot.active.map(id => doc.layers.find(l => l.id === id)); doc.activeHistoryState = { id: snapshot.history }; }
        }
      } };
      f.currentContext = context; return fn(context);
    } },
    action: {
      addNotificationListener: async (_, callback) => { f.notifications = callback; },
      batchPlay: async commands => {
        const responses = [];
        for (const command of commands) {
          f.commands.push(structuredClone(command)); if (f.onCommand) await f.onCommand(command);
          if (f.failCommand && f.failCommand(command)) { responses.push({ _obj: 'error', result: -25922, message: 'fixture command failure' }); continue; }
          const targetId = [...(command._target || []), ...(command.null instanceof Array ? command.null : [])].find(t => t._ref === 'layer')?._id;
          const layer = targetId ? doc.layers.find(l => l.id === targetId) : doc.activeLayers[0];
          if (command._obj === 'set') {
            if (command.to.name != null) layer.name = command.to.name;
            if (command.to.opacity != null) layer.opacity = command.to.opacity._value;
          } else if (command._obj === 'show' || command._obj === 'hide') layer.visible = command._obj === 'show';
          else if (command._obj === 'delete') { doc.layers = doc.layers.filter(l => l.id !== targetId); doc.activeLayers = [doc.layers[0]].filter(Boolean); }
          else if (command._obj === 'placeEvent') {
            const file = f.files.find(file => file.token === command.null._path), info = pixels.inspectImage(file.bytes, file.name.endsWith('.png') ? 'image/png' : 'image/jpeg');
            const w = info.width / 2, h = info.height / 2;
            const added = { id: ++layerCounter, name: 'Placed', visible: true, opacity: 100, kind: 'smartObject', sourceSize: info, quad: [0, 0, w, 0, w, h, 0, h] };
            doc.layers.push(added); doc.activeLayers = [added];
          } else if (command._obj === 'get') {
            responses.push({ smartObjectMore: { size: { width: layer.sourceSize.width, height: layer.sourceSize.height }, transform: [...layer.quad] } }); continue;
          } else if (command._obj === 'transform') {
            const x = layer.quad[0], y = layer.quad[1], sx = command.width._value / 100, sy = command.height._value / 100;
            layer.quad = layer.quad.map((v, i) => i % 2 ? y + (v - y) * sy : x + (v - x) * sx);
          } else if (command._obj === 'move') layer.quad = layer.quad.map((v, i) => v + (i % 2 ? command.to.vertical._value : command.to.horizontal._value));
          else if (command._obj === 'rasterizeLayer') layer.kind = 'pixel';
          else if (command._obj === 'make') layer.maskCreated = true;
          else throw Error('Unmodeled Photoshop command: ' + command._obj);
          responses.push({ _obj: command._obj });
        }
        return responses;
      }
    },
    imaging: {
      getSelection: async input => {
        f.maskReads.push(structuredClone(input));
        const b = input.sourceBounds, width = b.right - b.left, height = b.bottom - b.top;
        const data = Uint8Array.from({ length: width * height }, (_, i) => f.maskSamples[i % f.maskSamples.length]);
        return { sourceBounds: { ...b }, imageData: { width, height, components: 1, componentSize: 8, getData: async () => data, dispose: () => f.disposed++ } };
      },
      getPixels: async input => {
        f.imageReads.push(structuredClone(input));
        if (f.onPixels) return f.onPixels(input);
        const b = input.sourceBounds, width = b.right - b.left, height = b.bottom - b.top;
        const data = Uint8Array.from({ length: width * height * 4 }, (_, i) => [31, 63, 127, 192][i % 4]); f.imageSamples = [...data];
        return { sourceBounds: { ...b }, imageData: { width, height, components: 4, componentSize: 8, getData: async () => data, dispose: () => f.disposed++ } };
      },
      createImageDataFromBuffer: async (buffer, settings) => ({ ...settings, samples: [...buffer], dispose: () => f.maskDisposed++ }),
      putLayerMask: async input => {
        if (f.failMask) return { _obj: 'error', result: -1 };
        const layer = doc.layers.find(l => l.id === input.layerID); assert.equal(input.documentID, doc.id); assert.equal(input.replace, true);
        layer.mask = { samples: [...input.imageData.samples], width: input.imageData.width, height: input.imageData.height, targetBounds: { ...input.targetBounds } };
      }
    }
  };
  f.ps = ps; f.uxp = { storage: { localFileSystem: fs, formats: { binary: 'binary' } } };
  f.execute = createExecutor(ps, codec, { studioOptions: { uxp: f.uxp, ...options } });
  f.capture = (scope = 'selection') => f.execute('studio_capture', { documentId: 1, scope });
  f.layer = () => doc.layers.find(l => l.id === 2);
  return f;
}
function edit(capture, mutationId = 'mutation-1', changes = { name: 'Edited', opacity: 42, visible: false }) { return { documentRef: capture.documentRef, jobId: 'job-1', mutationId, layerId: 2, changes }; }
function apply(capture, mutationId = 'apply-1') {
  const width = 8, height = 6, binary = pixels.encodePNG(width, height, new Uint8Array(width * height * 4).fill(255), 4);
  return { documentRef: capture.documentRef, jobId: 'job-1', mutationId, image: { base64: Buffer.from(binary).toString('base64'), mimeType: 'image/png', width, height }, ...(capture.mask ? { mask: capture.mask } : {}), transform: capture.transform, settings: { groupResults: false, returnType: 'new-layer' } };
}
const code = wanted => error => { assert.equal(error.code, wanted); return true; };

test('PNG gray/RGBA samples and SHA-256 agree with independent standard implementations', () => {
  for (const text of ['', 'abc', '中文 🎨', 'a'.repeat(1000)]) assert.equal(pixels.sha256(text), createHash('sha256').update(text).digest('hex'));
  const sample = Uint8Array.from([0, 64, 128, 255]);
  assert.deepEqual(readPNG(Buffer.from(pixels.encodePNG(2, 2, sample, 1)).toString('base64')).samples, [...sample]);
  assert.deepEqual(pixels.inspectImage(pixels.encodePNG(2, 2, sample, 1), 'image/png'), { width: 2, height: 2 });
});
test('production captures exact source RGBA plus holed, feathered selection; disposes native data', async () => {
  const f = fixture(), capture = await f.capture(), image = readPNG(capture.image.base64), mask = readPNG(capture.mask.base64);
  assert.equal(image.components, 4); assert.deepEqual(image.samples, f.imageSamples);
  assert.equal(mask.components, 1); assert.deepEqual(mask.samples, f.maskSamples);
  assert.deepEqual(capture.transform, { sourceBounds: { left: 2, top: 1, right: 6, bottom: 4 }, inputWidth: 4, inputHeight: 3 });
  assert.equal(Object.hasOwn(capture, 'maskPixels'), false);
  assert.equal(Object.hasOwn(f.imageReads[0], 'targetSize'), false); assert.equal(Object.hasOwn(f.maskReads[0], 'targetSize'), false);
  assert.equal(f.imageReads[0].colorProfile, 'sRGB IEC61966-2.1'); assert.equal(capture.adaptation.sourceBitDepth, 16); assert.equal(capture.adaptation.resized, false);
  assert.equal(capture.documentRef.historyStateId, 10); assert.equal(f.disposed, 2); assert.equal(f.commands.length, 0);
});
test('Photoshop BitsPerChannelType string enums normalize to numeric source metadata', async () => {
  const f = fixture();
  f.ps.constants = { BitsPerChannelType: { EIGHT: 'bitDepth8', SIXTEEN: 'bitDepth16', THIRTYTWO: 'bitDepth32' } };
  for (const [hostValue, expected] of [['bitDepth8', 8], ['bitDepth16', 16]]) {
    f.doc.bitsPerChannel = hostValue;
    assert.equal((await f.capture()).adaptation.sourceBitDepth, expected);
  }
  f.doc.bitsPerChannel = 'bitDepth32'; await assert.rejects(f.capture(), code('UNSUPPORTED_DOCUMENT'));
});
test('scope must be explicit, empty selection never expands; document scope is explicitly full frame', async () => {
  const f = fixture(); await assert.rejects(f.execute('studio_capture', { documentId: 1 }), code('INVALID_INPUT'));
  f.doc.selection.bounds = null; await assert.rejects(f.capture(), code('NO_SELECTION')); assert.equal(f.imageReads.length, 0);
  const capture = await f.capture('document'); assert.equal(capture.mask, undefined); assert.equal(capture.image.width, 8); assert.equal(capture.image.height, 6);
  assert.deepEqual(capture.transform.sourceBounds, { left: 0, top: 0, right: 8, bottom: 6 });
});
test('unsupported depth, excessive pixels, missing mask API, or mismatched buffers fail explicitly', async () => {
  const f = fixture(); f.doc.bitsPerChannel = 32; await assert.rejects(f.capture(), code('UNSUPPORTED_DOCUMENT'));
  f.doc.bitsPerChannel = 8; f.doc.width = 9000; f.doc.height = 1000; await assert.rejects(f.capture('document'), code('IMAGE_TOO_LARGE')); assert.equal(f.imageReads.length, 0);
  f.doc.width = 8; f.doc.height = 6; const getSelection = f.ps.imaging.getSelection; delete f.ps.imaging.getSelection;
  await assert.rejects(f.capture(), code('HOST_UNSUPPORTED')); f.ps.imaging.getSelection = getSelection;
  f.onPixels = async input => ({ sourceBounds: input.sourceBounds, imageData: { width: 4, height: 3, components: 4, componentSize: 8, getData: async () => new Uint8Array(2), dispose: () => f.disposed++ } });
  await assert.rejects(f.capture(), code('HOST_PIXEL_FORMAT')); assert.equal(f.disposed, 2);
});
test('native property edit has a receipt and rollback restores existing layer without deleting it', async () => {
  const f = fixture(), capture = await f.capture(), request = edit(capture), changed = await f.execute('studio_edit_layer', request);
  assert.deepEqual(changed.receipt.createdLayerIds, []); assert.equal(changed.receipt.modifiedLayers[0].before.name, 'Original layer'); assert.equal(changed.receipt.preHistoryStateId, 10);
  assert.equal(f.layer().name, 'Edited'); assert.equal(f.layer().visible, false);
  const rolled = await f.execute('studio_rollback', { receipt: changed.receipt });
  assert.equal(rolled.receipt.rollbackStatus, 'rolled-back'); assert.equal(f.layer().name, 'Original layer'); assert.equal(f.layer().opacity, 80); assert.equal(f.layer().visible, true);
  assert.equal(f.commands.some(c => c._obj === 'delete'), false);
  const count = f.commands.length;
  assert.deepEqual(await f.execute('studio_rollback', { receipt: changed.receipt }), rolled);
  assert.equal((await f.execute('studio_edit_layer', request)).receipt.rollbackStatus, 'rolled-back'); assert.equal(f.commands.length, count);
});
test('repeated and concurrent mutation IDs issue one write and changed payload conflicts', async () => {
  const f = fixture(), capture = await f.capture(), request = edit(capture);
  const [first, second] = await Promise.all([f.execute('studio_edit_layer', request), f.execute('studio_edit_layer', structuredClone(request))]);
  assert.deepEqual(first, second); assert.equal(f.suspensions.length, 1);
  await assert.rejects(f.execute('studio_edit_layer', { ...request, changes: { opacity: 9 } }), code('MUTATION_CONFLICT'));
  first.receipt.createdLayerIds.push(2); assert.deepEqual((await f.execute('studio_edit_layer', request)).receipt.createdLayerIds, []);
});
test('native placement uses full-image coordinates and actual mask; rollback deletes only its new layer', async () => {
  const f = fixture(), capture = await f.capture(), result = await f.execute('studio_apply_result', apply(capture));
  const [id] = result.receipt.createdLayerIds, created = f.doc.layers.find(l => l.id === id);
  assert.notEqual(id, 2); assert.deepEqual(created.quad, [2, 1, 6, 1, 6, 4, 2, 4]);
  assert.deepEqual(created.mask.samples, f.maskSamples); assert.deepEqual(created.mask.targetBounds, { left: 2, top: 1 });
  assert.equal(created.kind, 'pixel'); assert.equal(result.receipt.placement.masked, true); assert.equal(f.maskDisposed, 1); assert.equal(f.files[0].deleted, true);
  const before = f.commands.length; await f.execute('studio_apply_result', apply(capture)); assert.equal(f.commands.length, before);
  await f.execute('studio_rollback', { receipt: result.receipt });
  assert.deepEqual(f.doc.layers.map(l => l.id), [2]); assert.equal(f.layer().name, 'Original layer');
  assert.deepEqual(f.commands.filter(c => c._obj === 'delete').map(c => c._target[0]._id), [id]);
});
test('source transform, actual dimensions and captured mask cannot be substituted', async () => {
  const f = fixture(), capture = await f.capture(), request = apply(capture);
  const noMask = { ...request, mutationId: 'missing-mask' }; delete noMask.mask;
  await assert.rejects(f.execute('studio_apply_result', noMask), code('MASK_REQUIRED'));
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'changed-mask', mask: { ...request.mask, base64: request.image.base64 } }), code('MASK_MISMATCH'));
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'changed-dimensions', image: { ...request.image, width: 7 } }), code('IMAGE_DIMENSION_MISMATCH'));
  const changedScope = { ...request, mutationId: 'changed-scope', transform: { sourceBounds: { left: 0, top: 0, right: 8, bottom: 6 }, inputWidth: 8, inputHeight: 6 } }; delete changedScope.mask;
  await assert.rejects(f.execute('studio_apply_result', changedScope), code('SOURCE_MISMATCH'));
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'unsupported-group', settings: { groupResults: true } }), code('HOST_UNSUPPORTED'));
  assert.equal(f.commands.length, 0); assert.equal(f.files.length, 0);
});
test('document-mode result can be applied without mask only after an explicit document capture', async () => {
  const f = fixture(), capture = await f.capture('document'), result = await f.execute('studio_apply_result', apply(capture));
  const created = f.doc.layers.find(l => l.id === result.receipt.createdLayerIds[0]);
  assert.equal(created.mask, undefined); assert.equal(result.receipt.placement.masked, false); assert.deepEqual(created.quad, [0, 0, 8, 0, 8, 6, 0, 6]);
});
test('switching document before modal execution never changes the new active document', async () => {
  const f = fixture(), capture = await f.capture();
  f.onModal = () => { f.ps.app.activeDocument = { id: 9 }; };
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), code('DOCUMENT_CONFLICT'));
  assert.equal(f.commands.length, 0); assert.equal(f.layer().name, 'Original layer');
});
test('closing/reopening even an identical document wrapper invalidates tokens; plugin reload invalidates receipts', async () => {
  const f = fixture(), capture = await f.capture(); f.notifications('close', { documentID: 1 }); f.notifications('open', { documentID: 1 });
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), code('DOCUMENT_CONFLICT'));
  const refreshed = await f.capture(); assert.notEqual(refreshed.documentRef.documentToken, capture.documentRef.documentToken);
  const changed = await f.execute('studio_edit_layer', edit(refreshed, 'fresh'));
  const reloaded = createExecutor(f.ps, codec, { studioOptions: { uxp: f.uxp } });
  await assert.rejects(reloaded('studio_rollback', { receipt: changed.receipt }), code('ROLLBACK_CONFLICT'));
  await assert.rejects(reloaded('studio_edit_layer', edit(refreshed, 'reloaded')), code('DOCUMENT_CONFLICT'));
});
test('source edits and follow-on edits produce conflicts, including unchanged fake history with changed properties', async () => {
  const f = fixture(), capture = await f.capture(); f.doc.activeHistoryState.id++;
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), code('DOCUMENT_CONFLICT'));
  const fresh = await f.capture(), result = await f.execute('studio_edit_layer', edit(fresh, 'fresh'));
  f.layer().name = 'User follow-on edit';
  await assert.rejects(f.execute('studio_rollback', { receipt: result.receipt }), code('ROLLBACK_CONFLICT'));
  assert.equal(f.layer().name, 'User follow-on edit'); assert.equal(f.commands.some(c => c._obj === 'delete'), false);
  f.doc.activeHistoryState.id++;
  await assert.rejects(f.execute('studio_rollback', { receipt: result.receipt }), code('ROLLBACK_CONFLICT'));
});
test('forged or altered receipts cannot delete a preexisting layer', async () => {
  const f = fixture(), capture = await f.capture(), result = await f.execute('studio_apply_result', apply(capture));
  await assert.rejects(f.execute('studio_rollback', { receipt: { ...result.receipt, createdLayerIds: [2] } }), code('ROLLBACK_CONFLICT'));
  await assert.rejects(f.execute('studio_rollback', { receipt: { ...result.receipt, mutationId: 'unknown' } }), code('ROLLBACK_CONFLICT'));
  assert.equal(f.commands.some(c => c._obj === 'delete'), false); assert.equal(f.layer().name, 'Original layer');
});
test('batchPlay error after a partial property change aborts the entire transaction and is never resent', async () => {
  const f = fixture(), capture = await f.capture(), request = edit(capture); f.failCommand = command => command._obj === 'hide';
  await assert.rejects(f.execute('studio_edit_layer', request), code('HOST_EXECUTION_FAILED'));
  assert.equal(f.layer().name, 'Original layer'); assert.equal(f.layer().opacity, 80); assert.equal(f.doc.activeHistoryState.id, 10); assert.equal(f.resumes.at(-1).commit, false);
  const attempts = f.commands.length; f.failCommand = null;
  await assert.rejects(f.execute('studio_edit_layer', request), code('HOST_EXECUTION_FAILED')); assert.equal(f.commands.length, attempts);
});
test('mask failure after layer creation removes the partial layer through native transaction rollback', async () => {
  const f = fixture(), capture = await f.capture(); f.failMask = true;
  await assert.rejects(f.execute('studio_apply_result', apply(capture)), code('HOST_EXECUTION_FAILED'));
  assert.deepEqual(f.doc.layers.map(l => l.id), [2]); assert.equal(f.doc.activeHistoryState.id, 10);
  assert.equal(f.maskDisposed, 1); assert.equal(f.files[0].deleted, true); assert.equal(f.resumes.at(-1).commit, false);
});
test('native cancellation rolls back; failed rollback closes the automatic-write circuit', async () => {
  const f = fixture(), capture = await f.capture(); f.onCommand = () => { f.currentContext.isCancelled = true; };
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), code('HOST_CANCELLED')); assert.equal(f.layer().name, 'Original layer');
  f.onCommand = null; f.failCommand = command => command._obj === 'hide'; f.failResume = true;
  await assert.rejects(f.execute('studio_edit_layer', edit(capture, 'uncertain')), code('HOST_RECOVERY_REQUIRED'));
  const commands = f.commands.length;
  await assert.rejects(f.execute('studio_edit_layer', edit(capture, 'next')), code('HOST_RECOVERY_REQUIRED')); assert.equal(f.commands.length, commands);
});
test('capture cannot outlive source history changes and disposes data on read failures', async () => {
  const f = fixture(); f.onPixels = async input => ({ sourceBounds: input.sourceBounds, imageData: { width: 4, height: 3, components: 4, componentSize: 8, getData: async () => { f.doc.activeHistoryState.id++; return new Uint8Array(48); }, dispose: () => f.disposed++ } });
  await assert.rejects(f.capture(), code('DOCUMENT_CONFLICT')); assert.equal(f.disposed, 2);
  f.onPixels = async input => ({ sourceBounds: input.sourceBounds, imageData: { width: 4, height: 3, components: 4, componentSize: 8, getData: async () => { throw Error('native read failed'); }, dispose: () => f.disposed++ } });
  await assert.rejects(f.capture(), /native read failed/); assert.equal(f.disposed, 4);
});
test('missing lifecycle/history transaction support fails before any document write', async () => {
  const f = fixture(); delete f.ps.action.addNotificationListener;
  await assert.rejects(f.capture(), code('HOST_UNSUPPORTED')); assert.equal(f.commands.length, 0);
  const g = fixture(), capture = await g.capture(); g.ps.core.executeAsModal = async fn => fn({});
  await assert.rejects(g.execute('studio_edit_layer', edit(capture)), code('HOST_UNSUPPORTED')); assert.equal(g.commands.length, 0);
});
test('deadline expiry while the host is executing rolls back partial edits', async () => {
  const f = fixture(), capture = await f.capture();
  f.onCommand = async () => { await new Promise(resolve => setTimeout(resolve, 12)); };
  await assert.rejects(f.execute('studio_edit_layer', edit(capture), Date.now() + 5), code('REQUEST_EXPIRED'));
  assert.equal(f.layer().name, 'Original layer'); assert.equal(f.doc.activeHistoryState.id, 10);
  assert.equal(f.resumes.at(-1).commit, false);
});
test('empty or disposed selection data is never converted to a rectangle; evicted provenance rejects apply', async () => {
  const f = fixture(); f.maskSamples.fill(0);
  await assert.rejects(f.capture(), code('NO_SELECTION')); assert.equal(f.imageReads.length, 0); assert.equal(f.disposed, 1);
  const g = fixture({ captureByteLimit: 12 }), original = await g.capture();
  g.doc.selection.bounds = { left: 0, top: 0, right: 4, bottom: 3 }; await g.capture();
  await assert.rejects(g.execute('studio_apply_result', apply(original)), code('SOURCE_MISMATCH')); assert.equal(g.commands.length, 0);
});
test('WebP, bad image signature and native decoded-dimension mismatch never become successful placement', async () => {
  const f = fixture(), capture = await f.capture(), request = apply(capture);
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'webp', image: { ...request.image, mimeType: 'image/webp' } }), code('UNSUPPORTED_FORMAT'));
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'bad-png', image: { ...request.image, base64: 'AAAA' } }), code('INVALID_IMAGE'));
  f.onCommand = command => { if (command._obj === 'get') f.doc.activeLayers[0].sourceSize.width++; };
  await assert.rejects(f.execute('studio_apply_result', { ...request, mutationId: 'native-mismatch' }), code('IMAGE_DIMENSION_MISMATCH'));
  assert.deepEqual(f.doc.layers.map(l => l.id), [2]); assert.equal(f.doc.activeHistoryState.id, 10); assert.equal(f.files[0].deleted, true);
});
test('rollback transaction failure restores the created layer and leaves receipt available for a safe retry', async () => {
  const f = fixture(), capture = await f.capture(), changed = await f.execute('studio_apply_result', apply(capture));
  f.failCommand = command => command._obj === 'delete';
  await assert.rejects(f.execute('studio_rollback', { receipt: changed.receipt }), code('HOST_EXECUTION_FAILED'));
  assert.deepEqual(f.doc.layers.map(l => l.id), [2, changed.receipt.createdLayerIds[0]]);
  f.failCommand = null;
  assert.equal((await f.execute('studio_rollback', { receipt: changed.receipt })).receipt.rollbackStatus, 'rolled-back'); assert.deepEqual(f.doc.layers.map(l => l.id), [2]);
});
