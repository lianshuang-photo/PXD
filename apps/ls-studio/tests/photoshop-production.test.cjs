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
        suspendHistory: async input => { if (f.onSuspend) await f.onSuspend(); assert.equal(input.documentID, doc.id); snapshot = { layers: structuredClone(doc.layers), active: doc.activeLayers.map(l => l.id), history: doc.activeHistoryState.id }; f.suspensions.push(input); return 'suspension-' + f.suspensions.length; },
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
          // The installed Adobe SDK emits a layer-only _target for show/hide.
          // Do not accept null aliases or silently fall back to the selected layer.
          if (command._obj === 'show' || command._obj === 'hide') {
            assert.equal(Object.hasOwn(command, 'null'), false, 'Visibility commands must not use null');
            assert.ok(Array.isArray(command._target) && command._target.length === 1, 'Visibility requires one explicit layer target');
            const target = command._target[0];
            assert.ok(target && Number.isInteger(target._id) && target._id > 0, 'Visibility requires a layer ID');
            assert.deepEqual(command._target, [{ _ref: 'layer', _id: target._id }], 'Visibility only accepts a layer reference');
          }
          const targetId = (command._target || []).find(t => t._ref === 'layer')?._id;
          const layer = targetId ? doc.layers.find(l => l.id === targetId) : doc.activeLayers[0];
          if (command._obj === 'set') {
            if (command.to.name != null) layer.name = command.to.name;
            if (command.to.opacity != null && !f.ignoreOpacity && !(f.singlePropertyPerSet && command.to.name != null)) {
              const requested = command.to.opacity._value;
              layer.opacity = f.quantizeOpacity ? Math.round(requested * 255 / 100) * 100 / 255 : requested;
            }
          } else if (command._obj === 'show' || command._obj === 'hide') {
            assert.ok(layer, 'Visibility target must exist'); layer.visible = command._obj === 'show';
          }
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
test('visibility fixture rejects missing, aliased, composite and invalid targets without changing a layer', async () => {
  const layer = { _ref: 'layer', _id: 2 }, document = { _ref: 'document', _id: 1 };
  for (const operation of ['show', 'hide']) {
    for (const fields of [{}, { null: [layer] }, { _target: [layer], null: [layer] }, { _target: [] }, { _target: layer }, { _target: [layer, document] }, { _target: [document] }, { _target: [{ _ref: 'layer' }] }, { _target: [{ _ref: 'layer', _id: 999 }] }]) {
      const f = fixture(), before = structuredClone(f.doc.layers);
      await assert.rejects(f.ps.action.batchPlay([{ _obj: operation, ...fields }]), /visibility/i);
      assert.deepEqual(f.doc.layers, before);
    }
  }
});
test('direct and combined visibility edits target an unselected layer and rollback either initial visibility', async () => {
  for (const initialVisible of [true, false]) {
    for (const combined of [false, true]) {
      const f = fixture(); f.layer().visible = initialVisible;
      const selected = { id: 3, name: 'Selected layer', visible: !initialVisible, opacity: 65, kind: 'pixel' };
      f.doc.layers.push(selected, { id: 4, name: 'Other layer', visible: initialVisible, opacity: 25, kind: 'pixel' }); f.doc.activeLayers = [selected];
      const before = structuredClone(f.doc.layers), capture = await f.capture();
      const changes = { ...(combined ? { name: 'Changed target', opacity: 42 } : {}), visible: !initialVisible };
      const changed = await f.execute('studio_edit_layer', edit(capture, 'visibility-edit', changes));
      assert.equal(f.layer().visible, !initialVisible);
      assert.deepEqual(f.doc.layers.slice(1), before.slice(1)); assert.deepEqual(f.doc.activeLayers.map(l => l.id), [3]);
      const visibilityCommand = f.commands.find(c => c._obj === 'show' || c._obj === 'hide');
      assert.deepEqual(visibilityCommand, { _obj: initialVisible ? 'hide' : 'show', _target: [{ _ref: 'layer', _id: 2 }], _options: { dialogOptions: 'dontDisplay' } });
      const start = f.commands.length;
      await f.execute('studio_rollback', { receipt: changed.receipt });
      assert.deepEqual(f.doc.layers, before); assert.deepEqual(f.doc.activeLayers.map(l => l.id), [3]);
      const restoration = f.commands.slice(start);
      assert.equal(restoration.length, combined ? 3 : 1);
      assert.deepEqual(restoration.at(-1), { _obj: initialVisible ? 'show' : 'hide', _target: [{ _ref: 'layer', _id: 2 }], _options: { dialogOptions: 'dontDisplay' } });
    }
  }
});
test('rollback emits only properties that actually changed and never unrelated visibility', async () => {
  for (const initialVisible of [true, false]) {
    for (const changes of [{ name: 'Renamed' }, { opacity: 42 }, { name: 'Renamed', opacity: 42 }, { name: 'Renamed', opacity: 80, visible: initialVisible }]) {
      const f = fixture(); f.layer().visible = initialVisible;
      const before = structuredClone(f.layer()), capture = await f.capture();
      const changed = await f.execute('studio_edit_layer', edit(capture, 'property-edit', changes)), start = f.commands.length;
      await f.execute('studio_rollback', { receipt: changed.receipt });
      const restoredFields = f.commands.slice(start).map(command => {
        assert.equal(command._obj, 'set'); return Object.keys(command.to).filter(key => key !== '_obj');
      }).flat();
      assert.deepEqual(restoredFields, [ ...(changes.name ? ['name'] : []), ...(changes.opacity !== undefined && changes.opacity !== before.opacity ? ['opacity'] : []) ]);
      assert.deepEqual(f.layer(), before);
    }
  }
});
test('rollback uses actual opacity snapshots across quantization, unchanged buckets and tiny changes', async () => {
  for (const scenario of [
    { before: 80, requested: 50, after: 128 * 100 / 255, quantize: true, writes: 1 },
    { before: 128 * 100 / 255, requested: 50.1, after: 128 * 100 / 255, quantize: true, writes: 0 },
    { before: 80, requested: 80 + 0.0000005, after: 80 + 0.0000005, quantize: false, writes: 1 }
  ]) {
    const f = fixture(); f.layer().opacity = scenario.before; f.quantizeOpacity = scenario.quantize;
    const capture = await f.capture(), changed = await f.execute('studio_edit_layer', edit(capture, 'opacity-edit', { opacity: scenario.requested }));
    assert.equal(changed.receipt.modifiedLayers[0].after.opacity, scenario.after);
    const start = f.commands.length; await f.execute('studio_rollback', { receipt: changed.receipt });
    const restoration = f.commands.slice(start); assert.equal(restoration.length, scenario.writes);
    if (scenario.writes) assert.deepEqual(restoration[0].to, { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: scenario.before } });
    assert.equal(f.layer().opacity, scenario.before); assert.equal(f.layer().name, 'Original layer'); assert.equal(f.layer().visible, true);
  }
});
test('visibility edit and rollback reject document or history changes before issuing commands', async () => {
  for (const operation of ['edit', 'rollback']) {
    for (const conflict of ['document', 'history']) {
      const f = fixture(), capture = await f.capture(), request = edit(capture, 'visibility-conflict', { visible: false });
      const changed = operation === 'rollback' ? await f.execute('studio_edit_layer', request) : null;
      const before = structuredClone(f.doc.layers), start = f.commands.length, suspensions = f.suspensions.length;
      // Exercise the guard again after executeAsModal grants entry.
      f.onModal = () => { if (conflict === 'document') f.ps.app.activeDocument = { id: 9 }; else f.doc.activeHistoryState.id++; };
      await assert.rejects(operation === 'rollback' ? f.execute('studio_rollback', { receipt: changed.receipt }) : f.execute('studio_edit_layer', request), code(operation === 'rollback' ? 'ROLLBACK_CONFLICT' : 'DOCUMENT_CONFLICT'));
      assert.equal(f.commands.length, start); assert.equal(f.suspensions.length, suspensions); assert.deepEqual(f.doc.layers, before);
    }
  }
});
test('rollback still guards unchanged fields and verifies the complete original state', async () => {
  for (const phase of ['guard', 'verification']) {
    const f = fixture(), capture = await f.capture(), changed = await f.execute('studio_edit_layer', edit(capture, 'name-only', { name: 'Renamed' }));
    const start = f.commands.length;
    if (phase === 'guard') f.layer().visible = false;
    else f.onCommand = () => { f.layer().visible = false; };
    await assert.rejects(f.execute('studio_rollback', { receipt: changed.receipt }), code(phase === 'guard' ? 'ROLLBACK_CONFLICT' : 'HOST_EXECUTION_FAILED'));
    assert.equal(f.commands.length - start, phase === 'guard' ? 0 : 1);
    assert.equal(f.layer().name, 'Renamed'); assert.equal(f.layer().visible, phase !== 'guard'); assert.equal(f.resumes.at(-1).commit, false);
  }
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
  await assert.rejects(f.capture(), code('HOST_EXECUTION_FAILED')); assert.equal(f.disposed, 4);
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

async function withRuntime(channel, work) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { PXD_RUNTIME: { channel } };
  try { return await work(); }
  finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}
function rewrapModalErrors(f) {
  const execute = f.ps.core.executeAsModal;
  f.ps.core.executeAsModal = async (...args) => {
    try { return await execute(...args); }
    catch (error) { throw new Error(String(error)); }
  };
}
test('UXP reconstructed modal errors preserve domain codes and recovery circuit details', async () => {
  const f = fixture(); rewrapModalErrors(f);
  f.doc.selection.bounds = null;
  await assert.rejects(f.capture(), code('NO_SELECTION'));
  const capture = await f.capture('document');
  f.failCommand = command => command._obj === 'hide';
  f.failResume = true;
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
    assert.equal(error.code, 'HOST_RECOVERY_REQUIRED');
    assert.equal(error.details.mutationMayHaveApplied, true);
    assert.equal(error.details.photoshopDiagnostic, undefined); return true;
  });
  const attempted = f.commands.length;
  await assert.rejects(f.execute('studio_edit_layer', edit(capture, 'next')), code('HOST_RECOVERY_REQUIRED'));
  assert.equal(f.commands.length, attempted);
});
test('development diagnostics distinguish native modal entry and history suspension failures', async () => withRuntime('development', async () => {
  for (const phase of ['modal-entry', 'history-suspend']) {
    const f = fixture(), capture = await f.capture();
    const native = Object.assign(new Error('Native host is busy'), { number: 9, params: { name: 'private layer name', pixels: 'private pixels', token: 'private token' } });
    if (phase === 'modal-entry') f.onModal = () => { throw native; };
    else { f.onSuspend = () => { throw native; }; rewrapModalErrors(f); }
    await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
      assert.equal(error.code, 'HOST_EXECUTION_FAILED');
      assert.deepEqual(error.details.photoshopDiagnostic, { stage: phase, native: { name: 'Error', number: 9, message: 'Native host is busy' } });
      assert.ok(error.message.includes(phase)); assert.ok(error.message.includes('PS 9'));
      assert.equal(JSON.stringify(error).includes('private'), false); return true;
    });
    assert.equal(f.commands.length, 0); assert.equal(f.layer().name, 'Original layer');
  }
}));
test('development preserves batch error diagnostics through native error wrapping and transaction rollback', async () => withRuntime('development', async () => {
  const f = fixture(), capture = await f.capture(); rewrapModalErrors(f);
  f.failCommand = command => command._obj === 'hide';
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
    assert.equal(error.code, 'HOST_EXECUTION_FAILED');
    assert.deepEqual(error.details.photoshopDiagnostic, { stage: 'batch-play', native: { result: -25922, message: 'fixture command failure' } }); return true;
  });
  assert.equal(f.layer().name, 'Original layer'); assert.equal(f.resumes.at(-1).commit, false);
}));
test('development diagnostic messages omit payloads, quoted values, paths and credentials', async () => withRuntime('development', async () => {
  const f = fixture(), capture = await f.capture();
  f.onSuspend = () => { throw Object.assign(new Error('Invalid value "private layer" at /Users/private/file token=secret-value Bearer secret-bearer data:image/png;base64,secret-pixel {"pixels":"secret-payload"}'), { number: 10 }); };
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
    const output = JSON.stringify({ message: error.message, details: error.details });
    assert.equal(/private|secret/.test(output), false); assert.ok(output.includes('Invalid value')); return true;
  });
}));
test('production and unspecified runtime channels do not expose native diagnostic output', async () => {
  for (const channel of ['production', undefined, 'test']) await withRuntime(channel, async () => {
    const f = fixture(), capture = await f.capture();
    f.onSuspend = () => { throw Object.assign(new Error('native diagnostic message'), { number: 9 }); };
    await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
      assert.equal(error.code, 'HOST_EXECUTION_FAILED'); assert.equal(error.details, undefined);
      assert.equal(error.message, 'Photoshop 无法执行本次模态操作'); return true;
    });
  });
});
test('native modal exit failure still trips recovery circuit after successful callback', async () => withRuntime('development', async () => {
  const f = fixture(), capture = await f.capture(), execute = f.ps.core.executeAsModal;
  f.ps.core.executeAsModal = async (...args) => { await execute(...args); throw Object.assign(new Error('Modal exit failed'), { number: 11 }); };
  await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
    assert.equal(error.code, 'HOST_RECOVERY_REQUIRED'); assert.equal(error.details.mutationMayHaveApplied, true);
    assert.equal(error.details.photoshopDiagnostic.stage, 'modal-exit'); assert.equal(error.details.photoshopDiagnostic.native.number, 11); return true;
  });
  assert.equal(f.layer().name, 'Edited');
}));
test('native codes and forged domain details never bypass safe error normalization', async () => {
  for (const channel of ['development', 'production']) for (const nativeCode of [9, 'ENOENT', 'HOST_RECOVERY_REQUIRED']) await withRuntime(channel, async () => {
    const f = fixture(), capture = await f.capture(); rewrapModalErrors(f);
    f.onSuspend = () => { throw Object.assign(new Error('Host failed token=fixture-secret at /Users/private/file ' + 'z'.repeat(5000)), {
      code: nativeCode, isHostError: true, details: { mutationMayHaveApplied: true, payload: 'fixture-private-pixels', photoshopDiagnostic: { message: 'fixture-secret' } }
    }); };
    await assert.rejects(f.execute('studio_edit_layer', edit(capture)), error => {
      assert.equal(error.code, 'HOST_EXECUTION_FAILED'); assert.ok(error.message.length < 600);
      const output = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(/fixture-secret|private|zzzz|payload|mutationMayHaveApplied/.test(output), false);
      if (channel === 'development') {
        assert.equal(error.details.photoshopDiagnostic.stage, 'history-suspend');
        assert.equal(error.details.photoshopDiagnostic.native.code, typeof nativeCode === 'number' ? nativeCode : undefined);
      } else assert.equal(error.details, undefined);
      return true;
    });
  });
});
test('capture and preparation normalize native errors while module domain errors retain their identity', async () => {
  const native = () => Object.assign(new Error('token=fixture-secret /Users/private/file'), { code: 'ENOENT', details: { pixels: 'private' } });
  const f = fixture(); f.onPixels = () => { throw native(); };
  await assert.rejects(f.capture(), error => { assert.equal(error.code, 'HOST_EXECUTION_FAILED'); assert.equal(error.message, 'Photoshop 无法完成本次请求'); assert.equal(error.details, undefined); return true; });
  f.onPixels = null; const capture = await f.capture();
  f.uxp.storage.localFileSystem.getTemporaryFolder = () => { throw native(); };
  await assert.rejects(f.execute('studio_apply_result', apply(capture)), error => { assert.equal(error.code, 'HOST_EXECUTION_FAILED'); assert.equal(error.details, undefined); assert.equal(error.message.includes('private'), false); return true; });
  const trusted = pixels.createHostError('NO_SELECTION', 'fixed domain message');
  assert.equal(pixels.isHostError(trusted), true); assert.equal(pixels.isHostError(Object.assign(new Error(trusted.message), trusted)), false);
  assert.equal(pixels.isHostError(undefined), false);
  f.doc.selection.bounds = null; await assert.rejects(f.capture(), code('NO_SELECTION'));
});
test('native lifecycle exceptions do not become trusted messages', async () => {
  const f = fixture(); f.ps.action.addNotificationListener = () => { throw Object.assign(new Error('token=fixture-secret /Users/private/file'), { code: 9 }); };
  await assert.rejects(f.capture(), error => { assert.equal(error.code, 'HOST_UNSUPPORTED'); assert.equal(error.message, '无法监听 Photoshop 文档生命周期'); assert.equal(error.details, undefined); return true; });
});
test('name and opacity changes work on Photoshop hosts that only apply one property per set', async () => {
  const f = fixture(), capture = await f.capture(); f.singlePropertyPerSet = true;
  const changed = await f.execute('studio_edit_layer', edit(capture, 'multi-property', { name: 'Updated', opacity: 60 }));
  assert.equal(f.layer().name, 'Updated'); assert.equal(f.layer().opacity, 60);
  assert.equal(f.suspensions.length, 1); assert.equal(f.resumes.length, 1); assert.equal(f.resumes[0].commit, true);
  assert.equal(f.commands.filter(c => c._obj === 'set').length, 2);
  await f.execute('studio_rollback', { receipt: changed.receipt });
  assert.equal(f.layer().name, 'Original layer'); assert.equal(f.layer().opacity, 80); assert.equal(f.suspensions.length, 2);
});
test('property mismatch diagnostics include only field names and opacity numbers and still roll back', async () => {
  for (const channel of ['development', 'production']) await withRuntime(channel, async () => {
    const f = fixture(), capture = await f.capture(); f.ignoreOpacity = true; rewrapModalErrors(f);
    await assert.rejects(f.execute('studio_edit_layer', edit(capture, 'mismatch', { name: 'private new name', opacity: 60 })), error => {
      assert.equal(error.code, 'HOST_EXECUTION_FAILED'); assert.equal(error.message.includes('private'), false);
      if (channel === 'development') {
        assert.deepEqual(error.details.photoshopDiagnostic, { stage: 'property-verification', fields: ['opacity'], opacity: { expected: 60, actual: 80 } });
        assert.ok(error.message.includes('opacity expected=60 actual=80'));
      } else assert.equal(error.details, undefined);
      return true;
    });
    assert.equal(f.layer().name, 'Original layer'); assert.equal(f.layer().opacity, 80); assert.equal(f.resumes.at(-1).commit, false);
  });
});
