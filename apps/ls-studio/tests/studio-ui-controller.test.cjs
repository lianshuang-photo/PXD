const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransport, createController, baseFor } = require('../plugin/studio-014');
const copy = value => structuredClone(value);
const context = () => ({ documentRef: { runtimeId: 'runtime-1', documentToken: 'doc-1', documentId: 1, historyStateId: 10, width: 8, height: 6, name: 'source.psd' }, scope: 'selection', baseAssetId: 'source-asset', selectionMaskAssetId: 'mask-asset', transform: { sourceBounds: { left: 2, top: 1, right: 6, bottom: 4 }, inputWidth: 4, inputHeight: 3 }, refs: [], preserve: [], settings: { autoApply: false, groupResults: false, returnType: 'new-layer' } });
function fixture(capabilityId = 'image.edit') {
  const f = { calls: [], drafts: [{ draftId: 'draft-1', revision: 1, capabilityId, params: capabilityId === 'image.edit' ? { prompt: 'Original' } : { layerId: 2, changes: { opacity: 50 } }, context: context() }], jobs: [], intercept: null, layer: { id: 2, name: 'Portrait', visible: true, opacity: 80 }, observedDocument: { id: 1, historyStateId: 10 }, configured: true };
  let nextId = 0;
  f.storage = { values: new Map(), getItem(key) { return this.values.get(key); }, setItem(key, value) { this.values.set(key, value); } };
  f.transport = { base: 'http://127.0.0.1:17881', readAsset: async id => 'data:image/png;base64,AA==', call: async (operation, args = {}) => {
    f.calls.push({ operation, args: copy(args) });
    if (f.intercept) { const response = await f.intercept(operation, args); if (response && response.handled) return response.value; }
    if (operation === 'discover') return { photoshop: { connected: true }, provider: { configured: f.configured, model: 'fixture', settings: { aspectRatio: ['auto', '1:1'], imageSize: ['1K'] } } };
    if (operation === 'listDrafts') return copy(f.drafts);
    if (operation === 'listJobs') return copy(f.jobs);
    if (operation === 'getDraft') return copy(f.drafts.find(d => d.draftId === args.draftId));
    if (operation === 'createDraft') { const draft = { ...copy(args), draftId: 'draft-' + (f.drafts.length + 1), revision: 1 }; f.drafts.push(draft); return copy(draft); }
    if (operation === 'deriveDraft') { const job = f.jobs.find(j => j.jobId === args.jobId), draft = { ...copy(job.snapshot), draftId: 'draft-' + (f.drafts.length + 1), revision: 1 }; if (args.mode === 'candidate-reference') draft.context.refs.push({ assetId: job.results.find(r => r.resultId === args.resultId).assetId, role: 'reference' }); f.drafts.push(draft); return copy(draft); }
    if (operation === 'updateDraft') {
      const draft = f.drafts.find(d => d.draftId === args.draftId);
      if (args.expectedRevision !== draft.revision) throw Object.assign(Error('Conflicting revision'), { code: 'REVISION_CONFLICT', status: 409, details: { current: copy(draft) } });
      draft.params = { ...draft.params, ...copy(args.params) }; draft.context = copy(args.context); draft.revision++; return copy(draft);
    }
    if (operation === 'run') {
      const old = f.jobs.find(j => j.requestId === args.requestId); if (old) return { job: copy(old), duplicate: true };
      const draft = f.drafts.find(d => d.draftId === args.draftId);
      const job = { jobId: 'job-' + (f.jobs.length + 1), requestId: args.requestId, status: 'queued', snapshot: copy(draft), results: [], placement: { status: 'not-requested' } };
      f.jobs.push(job); return { job: copy(job), duplicate: false };
    }
    if (operation === 'cancel') { const job = f.jobs.find(j => j.jobId === args.jobId); job.status = 'cancelled'; return copy(job); }
    if (operation === 'apply') { const job = f.jobs.find(j => j.jobId === args.jobId); job.placement = { status: 'applied', requestId: args.requestId, receipt: { resultId: args.resultId, mutationId: 'mutation-1' } }; return copy(job); }
    if (operation === 'rollback') { const job = f.jobs.find(j => j.jobId === args.jobId); job.placement.status = 'rolled-back'; return copy(job); }
    if (operation === 'capture') { const captured = context(); captured.scope = args.scope; if (args.scope === 'document') delete captured.selectionMaskAssetId; return captured; }
    if (operation === 'importAsset') return { assetId: 'imported-reference', width: 4, height: 3, mimeType: args.mimeType };
    if (operation === 'observe') {
      if (args.tool === 'photoshop_get_document') return { ok: true, open: true, document: copy(f.observedDocument) };
      if (args.tool === 'photoshop_list_layers') return { ok: true, layers: [copy(f.layer)], nextOffset: null };
      if (args.tool === 'photoshop_get_layer' && args.arguments.layerId === 999) return { ok: true, layer: { id: 999, name: 'A real later-page layer', opacity: 100, visible: true } };
      throw Object.assign(Error('Unknown layer'), { code: 'DOCUMENT_CONFLICT' });
    }
    throw Error('Unexpected operation ' + operation);
  } };
  f.newController = () => createController({ transport: f.transport, storage: f.storage, makeId: () => 'request-' + ++nextId });
  f.controller = f.newController(); return f;
}
const code = expected => e => { assert.equal(e.code, expected); return true; };

test('revision draft dispatch uses the chosen job and never saves or runs the current draft', async () => {
  const f = fixture(); f.jobs.push({ jobId: 'historical-job', snapshot: { ...copy(f.drafts[0]), params: { prompt: 'Historical instruction' } }, results: [{ resultId: 'result-1', assetId: 'candidate-asset' }], placement: { status: 'not-requested' } });
  await f.controller.refresh();
  f.drafts[0].params.prompt = 'Current instruction'; f.drafts[0].revision++; await f.controller.refresh();
  const revised = await f.controller.deriveDraft('historical-job', 'candidate-reference', 'result-1');
  assert.equal(revised.params.prompt, 'Historical instruction'); assert.notEqual(revised.draftId, 'draft-1');
  assert.equal(f.controller.snapshot().draft.draftId, revised.draftId); assert.equal(f.controller.snapshot().dirty, false);
  assert.deepEqual(f.calls.find(c => c.operation === 'deriveDraft').args, { jobId: 'historical-job', mode: 'candidate-reference', resultId: 'result-1', source: 'ui' });
  assert.equal(f.calls.some(c => ['updateDraft', 'run', 'apply'].includes(c.operation)), false);
});
test('unsaved edits prevent switching to a derived draft, including edits made while creation is pending', async () => {
  const f = fixture(); f.jobs.push({ jobId: 'historical-job', snapshot: copy(f.drafts[0]), results: [] }); await f.controller.refresh();
  f.controller.editParams({ prompt: 'Keep local' });
  await assert.rejects(f.controller.deriveDraft('historical-job', 'original'), code('UNSAVED_CHANGES'));
  assert.equal(f.calls.some(c => c.operation === 'deriveDraft'), false); await f.controller.reloadDraft();
  let release; f.intercept = async operation => { if (operation === 'deriveDraft') await new Promise(resolve => { release = resolve; }); };
  const pending = f.controller.deriveDraft('historical-job', 'original'); await new Promise(resolve => setImmediate(resolve));
  f.controller.editParams({ prompt: 'Typed during request' }); release(); const derived = await pending;
  assert.equal(f.controller.snapshot().draft.draftId, 'draft-1'); assert.equal(f.controller.snapshot().form.params.prompt, 'Typed during request');
  assert.ok(f.controller.snapshot().drafts.some(d => d.draftId === derived.draftId)); assert.equal(f.calls.some(c => c.operation === 'run'), false);
});
test('a late derived draft cannot rebind a disposed workspace connection', async () => {
  const f = fixture(); f.jobs.push({ jobId: 'historical-job', snapshot: copy(f.drafts[0]), results: [] }); await f.controller.refresh();
  let release; f.intercept = async operation => { if (operation === 'deriveDraft') await new Promise(resolve => { release = resolve; }); };
  const pending = f.controller.deriveDraft('historical-job', 'original'); await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, code('DISPOSED')); f.controller.dispose(); release(); await rejected;
  assert.equal(f.controller.snapshot().draft.draftId, 'draft-1'); assert.equal(f.calls.some(c => ['run', 'apply'].includes(c.operation)), false);
});

test('browser /ui/ uses the serving origin; transport sends shared operations and protected binary headers', async () => {
  const calls = [], location = { protocol: 'http:', origin: 'http://localhost:17881', pathname: '/ui/' };
  assert.equal(baseFor(location, 'http://127.0.0.1:17880'), location.origin);
  const transport = createTransport({ location, base: 'http://127.0.0.1:17880', fetchImpl: async (url, config) => {
    calls.push({ url, config });
    if (url.includes('/assets/')) return { ok: true, headers: { get: name => name === 'content-type' ? 'image/png' : '3' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { ready: true } }) };
  } });
  assert.deepEqual(await transport.call('getDraft', { draftId: 'draft-1' }), { ready: true });
  assert.deepEqual(JSON.parse(calls[0].config.body), { operation: 'getDraft', arguments: { draftId: 'draft-1' } });
  assert.equal(calls[0].url, location.origin + '/studio/call');
  assert.equal(await transport.readAsset('asset-1'), 'data:image/png;base64,AQID'); assert.equal(calls[1].config.headers['X-PXDLS-Agent'], '1');
});
test('polling updates clean Agent edits and never creates or runs a draft', async () => {
  const f = fixture(); await f.controller.refresh();
  f.drafts[0].params.prompt = 'Agent revision'; f.drafts[0].revision = 2; await f.controller.refresh();
  assert.equal(f.controller.snapshot().form.params.prompt, 'Agent revision'); assert.equal(f.controller.snapshot().draft.revision, 2);
  assert.ok(f.calls.every(c => ['discover', 'listDrafts', 'listJobs'].includes(c.operation)));
});
test('dirty local changes survive Agent updates; reload or save-as-new resolves without overwriting remote', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editParams({ prompt: 'Local unsaved' });
  f.drafts[0].params.prompt = 'Agent edited'; f.drafts[0].revision++; await f.controller.refresh();
  assert.equal(f.controller.snapshot().form.params.prompt, 'Local unsaved'); assert.equal(f.controller.snapshot().conflict.current.revision, 2);
  await assert.rejects(f.controller.save(), code('REVISION_CONFLICT')); await assert.rejects(f.controller.run(), code('REVISION_CONFLICT'));
  const fork = await f.controller.saveAsNew(); assert.equal(fork.params.prompt, 'Local unsaved'); assert.equal(f.drafts[0].params.prompt, 'Agent edited');
  await f.controller.loadDraft('draft-1'); f.controller.editParams({ prompt: 'Discard this' }); await f.controller.reloadDraft();
  assert.equal(f.controller.snapshot().form.params.prompt, 'Agent edited'); assert.equal(f.controller.snapshot().dirty, false);
});
test('revision conflict returned by the service preserves unsaved form and surfaces current revision', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editParams({ prompt: 'Local' }); f.drafts[0].revision++;
  await assert.rejects(f.controller.save(), code('REVISION_CONFLICT'));
  assert.equal(f.controller.snapshot().form.params.prompt, 'Local'); assert.equal(f.controller.snapshot().conflict.current.revision, 2);
});
test('typing while save is awaiting a response keeps later edits dirty against the new revision', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editParams({ prompt: 'First value' });
  let release; f.intercept = async operation => { if (operation === 'updateDraft') await new Promise(resolve => { release = resolve; }); };
  const saved = f.controller.save(); await new Promise(resolve => setImmediate(resolve)); f.controller.editParams({ prompt: 'Later value' }); release(); await saved;
  assert.equal(f.controller.snapshot().draft.revision, 2); assert.equal(f.controller.snapshot().form.params.prompt, 'Later value'); assert.equal(f.controller.snapshot().dirty, true);
  f.intercept = null; await f.controller.save(); assert.equal(f.drafts[0].params.prompt, 'Later value'); assert.equal(f.drafts[0].revision, 3);
});
test('switching service while a save is pending cannot dispatch a later generation on the old connection', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editParams({ prompt: 'New instruction' }); let release;
  f.intercept = async operation => { if (operation === 'updateDraft') await new Promise(resolve => { release = resolve; }); };
  const run = f.controller.run(); await new Promise(resolve => setImmediate(resolve)); f.controller.dispose(); release();
  await assert.rejects(run, code('DISPOSED')); assert.equal(f.calls.filter(c => c.operation === 'run').length, 0); assert.equal(f.controller.snapshot().pendingRun, null);
});
test('run saves refs, settings and prompt into the shared revision, and duplicate clicks do not create duplicate jobs', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editParams({ prompt: 'Retouch naturally' });
  await f.controller.importReference({ base64: 'AA==', mimeType: 'image/png' }, 'identity');
  f.controller.editContext({ preserve: ['Identity'], settings: { autoApply: false, groupResults: false, returnType: 'new-layer' } });
  const first = f.controller.run(); await assert.rejects(f.controller.run(), code('UI_BUSY')); const job = await first;
  assert.equal(job.snapshot.revision, 2); assert.equal(job.snapshot.params.prompt, 'Retouch naturally'); assert.deepEqual(job.snapshot.context.refs, [{ assetId: 'imported-reference', role: 'identity' }]);
  assert.equal(f.calls.filter(c => c.operation === 'run').length, 1); assert.equal(f.controller.snapshot().dirty, false);
});
test('ambiguous submissions survive controller reload; refresh reconciles durable request without rerunning', async () => {
  const f = fixture(); await f.controller.refresh();
  f.intercept = async (operation, args) => { if (operation === 'run') { f.jobs.push({ jobId: 'job-recovered', requestId: args.requestId, status: 'running', snapshot: copy(f.drafts[0]), results: [], placement: { status: 'not-requested' } }); throw Object.assign(Error('lost response'), { code: 'NETWORK_ERROR' }); } };
  await assert.rejects(f.controller.run(), code('NETWORK_ERROR')); assert.equal(f.controller.snapshot().pendingRun.requestId, 'request-1');
  f.controller.dispose(); f.intercept = null; const restored = f.newController(); await restored.refresh();
  assert.equal(restored.snapshot().pendingRun, null); assert.equal(restored.snapshot().selectedJobId, 'job-recovered'); assert.equal(f.calls.filter(c => c.operation === 'run').length, 1);
});
test('explicit retry reuses request ID and revision; polling never retries an uncertain submission', async () => {
  const f = fixture(); await f.controller.refresh(); f.intercept = async operation => { if (operation === 'run') throw Object.assign(Error('network down'), { code: 'NETWORK_ERROR' }); };
  await assert.rejects(f.controller.run(), code('NETWORK_ERROR')); await f.controller.refresh(); await assert.rejects(f.controller.run(), code('SUBMISSION_UNCERTAIN'));
  assert.equal(f.calls.filter(c => c.operation === 'run').length, 1);
  f.intercept = null; const job = await f.controller.retryRun();
  const calls = f.calls.filter(c => c.operation === 'run'); assert.deepEqual(calls[0].args, calls[1].args); assert.equal(job.requestId, 'request-1');
});
test('stale poll cannot revive a cancelled job; late results cannot be applied', async () => {
  const f = fixture(); await f.controller.refresh(); const job = await f.controller.run();
  let resolveJobs; f.intercept = async operation => { if (operation === 'listJobs') { const old = copy(f.jobs); await new Promise(resolve => { resolveJobs = resolve; }); return { handled: true, value: old }; } };
  const refresh = f.controller.refresh(); await new Promise(resolve => setImmediate(resolve)); await f.controller.cancel(job.jobId); resolveJobs(); await refresh;
  assert.equal(f.controller.snapshot().jobs[0].status, 'cancelled'); f.intercept = null;
  f.jobs[0].results = [{ resultId: 'result-1', assetId: 'result-asset' }]; await f.controller.refresh();
  await assert.rejects(f.controller.apply(job.jobId, 'result-1'), code('RESULT_REQUIRED')); assert.equal(f.calls.filter(c => c.operation === 'apply').length, 0);
});
test('candidate apply retries keep one identity; applied/rolled-back controls never replay generation', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.run(); f.jobs[0].status = 'succeeded'; f.jobs[0].results = [{ resultId: 'result-1', assetId: 'result-asset' }]; await f.controller.refresh();
  f.intercept = async operation => { if (operation === 'apply') throw Object.assign(Error('lost response'), { code: 'NETWORK_ERROR' }); };
  await assert.rejects(f.controller.apply('job-1', 'result-1'), code('NETWORK_ERROR')); f.intercept = null;
  await f.controller.apply('job-1', 'result-1'); await f.controller.apply('job-1', 'result-1');
  const applies = f.calls.filter(c => c.operation === 'apply'); assert.equal(applies.length, 2); assert.deepEqual(applies[0].args, applies[1].args);
  await f.controller.rollback('job-1'); await f.controller.rollback('job-1'); assert.equal(f.calls.filter(c => c.operation === 'rollback').length, 1);
  assert.equal(f.calls.filter(c => c.operation === 'run').length, 1);
});
test('resolved failed placement and rollback-conflict jobs never display a success notice', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.run(); f.jobs[0].status = 'succeeded'; f.jobs[0].results = [{ resultId: 'result-1', assetId: 'result-asset' }]; await f.controller.refresh();
  f.intercept = async operation => { if (operation === 'apply') { f.jobs[0].placement = { status: 'failed', error: { code: 'HOST_EXECUTION_FAILED', message: 'Native placement failed' } }; return { handled: true, value: copy(f.jobs[0]) }; } };
  await f.controller.apply('job-1', 'result-1'); assert.equal(f.controller.snapshot().notice, ''); assert.equal(f.controller.snapshot().error.code, 'HOST_EXECUTION_FAILED');
  f.jobs[0].placement = { status: 'applied', receipt: { mutationId: 'mutation-1', resultId: 'result-1' } }; f.intercept = null; await f.controller.refresh();
  f.intercept = async operation => { if (operation === 'rollback') { f.jobs[0].placement = { status: 'rollback-conflict', error: { code: 'ROLLBACK_CONFLICT', message: 'User edited the document' } }; return { handled: true, value: copy(f.jobs[0]) }; } };
  await f.controller.rollback('job-1'); assert.equal(f.controller.snapshot().notice, ''); assert.equal(f.controller.snapshot().error.code, 'ROLLBACK_CONFLICT');
});
test('native edits require observed document/layer IDs and can validate a real later-page layer', async () => {
  const f = fixture('ps.layer.update'); await f.controller.refresh();
  assert.throws(() => f.controller.selectLayer(44), code('LAYER_CONTEXT_CONFLICT'));
  await f.controller.refreshLayers(); assert.throws(() => f.controller.selectLayer(44), code('LAYER_CONTEXT_CONFLICT')); f.controller.selectLayer(2);
  f.observedDocument.historyStateId = 11; await assert.rejects(f.controller.run(), code('LAYER_CONTEXT_CONFLICT'));
  f.observedDocument.historyStateId = 10; f.controller.editParams({ layerId: 999 });
  const job = await f.controller.run(); assert.equal(job.snapshot.params.layerId, 999); assert.ok(f.calls.some(c => c.operation === 'observe' && c.args.tool === 'photoshop_get_layer'));
});
test('capturing a different or reopened document clears native layer targets even when layer IDs are reused', async () => {
  const f = fixture('ps.layer.update'); await f.controller.refresh(); f.observedDocument.id = 2;
  f.intercept = async operation => { if (operation === 'capture') { const captured = context(); captured.documentRef.documentId = 2; captured.documentRef.documentToken = 'document-B'; return { handled: true, value: captured }; } };
  await f.controller.capture('document');
  assert.equal(f.controller.snapshot().form.params.layerId, null); assert.deepEqual(f.controller.snapshot().form.params.changes, {});
  await f.controller.save(); assert.equal(f.drafts[0].params.layerId, null);
  await assert.rejects(f.controller.run(), code('LAYER_CONTEXT_CONFLICT')); assert.equal(f.calls.filter(c => c.operation === 'run').length, 0);
  f.controller.selectLayer(2); f.controller.editParams({ changes: { opacity: 30 } });
  const job = await f.controller.run(); assert.equal(job.snapshot.context.documentRef.documentId, 2); assert.equal(job.snapshot.params.layerId, 2);
});
test('explicit capture keeps shared references/settings while replacing source; Agent handoff references record instead of executing', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.editContext({ refs: [{ assetId: 'reference-1', role: 'style' }], preserve: ['costume'] });
  await f.controller.capture('document'); assert.equal(f.controller.snapshot().form.context.scope, 'document'); assert.equal(f.controller.snapshot().form.context.selectionMaskAssetId, undefined);
  assert.deepEqual(f.controller.snapshot().form.context.refs, [{ assetId: 'reference-1', role: 'style' }]);
  assert.throws(() => f.controller.agentReference(), code('UNSAVED_CHANGES')); await f.controller.save();
  assert.match(f.controller.agentReference(), /studio_get_draft/); assert.match(f.controller.agentReference(), /draft-1/); assert.equal(f.calls.some(c => c.operation === 'run'), false);
});
test('recipe list is compact; selected parameters/defaults load through one revision-checked shared operation', async () => {
  const f = fixture(); await f.controller.refresh();
  const recipe = { recipeId: 'recipe-1', title: 'Skin details', category: 'Portrait', sourceHash: 'source-hash', parameters: [{ id: 'strength', key: 'strength', label: '强度', defaultValue: 0.4, min: 0, max: 1, step: 0.01 }], requiresReferenceMapping: false };
  f.intercept = async (operation, args) => {
    if (operation === 'listRecipes') return { handled: true, value: { items: [{ recipeId: recipe.recipeId, title: recipe.title, category: recipe.category, parameterCount: 1 }], total: 1, nextOffset: null } };
    if (operation === 'getRecipe') return { handled: true, value: recipe };
    if (operation === 'loadRecipe') { assert.equal(args.expectedRevision, f.drafts[0].revision); const draft = f.drafts[0]; draft.revision++; draft.params = { ...draft.params, prompt: 'Compiled skin edit: ' + args.userText, recipe: { recipeId: recipe.recipeId, sourceHash: recipe.sourceHash, values: args.values } }; return { handled: true, value: copy(draft) }; }
  };
  await f.controller.searchRecipes('skin'); assert.equal(f.controller.snapshot().recipes.selected, null);
  await f.controller.selectRecipe('recipe-1'); assert.equal(f.controller.snapshot().recipes.values.strength, 0.4);
  f.controller.setRecipeValue('strength', 0.63); f.controller.setRecipeUserText('Keep skin texture');
  const loaded = await f.controller.loadSelectedRecipe(); assert.equal(loaded.params.recipe.values.strength, 0.63); assert.equal(loaded.revision, 2); assert.equal(f.calls.some(c => c.operation === 'run'), false);
  const load = f.calls.find(c => c.operation === 'loadRecipe'); assert.equal(load.args.userText, 'Keep skin texture'); assert.equal(load.args.source, 'ui'); assert.deepEqual(loaded.context, context());
});
test('out-of-order recipe searches do not replace the latest list, and missing recipe API leaves draft intact', async () => {
  const f = fixture(); await f.controller.refresh(); let release;
  f.intercept = async (operation, args) => { if (operation === 'listRecipes') { if (args.q === 'old') await new Promise(resolve => { release = resolve; }); return { handled: true, value: { items: [{ recipeId: args.q }], total: 1, nextOffset: null } }; } };
  const old = f.controller.searchRecipes('old'); await new Promise(resolve => setImmediate(resolve)); await f.controller.searchRecipes('new'); release(); await old;
  assert.equal(f.controller.snapshot().recipes.items[0].recipeId, 'new');
  f.intercept = async () => { throw Object.assign(Error('endpoint unavailable'), { code: 'NOT_FOUND' }); };
  await assert.rejects(f.controller.searchRecipes('test')); assert.match(f.controller.snapshot().recipes.error, /当前草稿仍可编辑/); assert.equal(f.controller.snapshot().form.params.prompt, 'Original');
});

module.exports = { fixture, context };
