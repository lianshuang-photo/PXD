'use strict';
const { randomUUID } = require('node:crypto');
const { DomainError, invariant, clone, id, capabilityDefinitions, validateSchema, hostOperations, validateContext, publicError } = require('../domain/contracts');

const imageMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
const placementLimits = { pixels: 8000000, imageBytes: 32 * 1024 * 1024, mimeTypes: ['image/png', 'image/jpeg'], returnTypes: ['new-layer'], groupResults: false };
function decodeImage(image) {
  invariant(image && imageMime.has(image.mimeType), 'INVALID_IMAGE', 'PNG, JPEG or WebP image required');
  invariant(typeof image.base64 === 'string' && image.base64.length > 0 && image.base64.length <= 48 * 1024 * 1024 && image.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.base64), 'INVALID_IMAGE', 'Image data is invalid or too large');
  const data = Buffer.from(image.base64, 'base64');
  invariant(data.toString('base64') === image.base64, 'INVALID_IMAGE', 'Image data is not canonical base64');
  invariant(data.length <= 32 * 1024 * 1024, 'IMAGE_TOO_LARGE', 'Image exceeds 32 MiB');
  return data;
}
function asImage(value) { return { base64: value.data.toString('base64'), mimeType: value.asset.mimeType, width: value.asset.width, height: value.asset.height }; }
function validatePlacementSettings(settings = {}) {
  invariant(!settings.groupResults, 'HOST_UNSUPPORTED', 'Photoshop result grouping is not supported; disable groupResults before generating or placing results');
  invariant(settings.returnType == null || placementLimits.returnTypes.includes(settings.returnType), 'HOST_UNSUPPORTED', 'Photoshop placement only supports a new layer');
}
function validateGenerationPlacement(snapshot) {
  const settings = snapshot.context.settings || {};
  validatePlacementSettings(settings);
  invariant(!settings.autoApply || snapshot.params.imageSize !== '4K', 'UNSUPPORTED_OUTPUT', '4K output is not supported for automatic Photoshop placement within the 8,000,000-pixel limit; choose a smaller output or disable autoApply to retain the generated result without placement');
}
function validatePlacementImage(image) {
  invariant(placementLimits.mimeTypes.includes(image.asset.mimeType), 'UNSUPPORTED_OUTPUT', 'Photoshop placement supports PNG and JPEG only; this generated result remains available as a managed asset');
  invariant(image.asset.width * image.asset.height <= placementLimits.pixels, 'UNSUPPORTED_OUTPUT', 'Generated output exceeds the Photoshop placement limit of 8,000,000 pixels; the result remains available and was not resized or sent to Photoshop');
  invariant(image.data.length <= placementLimits.imageBytes, 'UNSUPPORTED_OUTPUT', 'Generated output exceeds the Photoshop placement limit of 32 MiB; the result remains available and was not sent to Photoshop');
}
function uncertainHost(error) { return ['HOST_UNCERTAIN', 'HOST_RECOVERY_REQUIRED'].includes(error.code); }
function sameProvenance(asset, context, purpose) {
  const source = asset.source, ref = context.documentRef;
  if (!source || asset.purpose !== purpose || source.scope !== context.scope || !source.documentRef || !source.transform) return false;
  const identity = ['runtimeId', 'documentToken', 'documentId', 'historyStateId', 'width', 'height'];
  if (!identity.every(key => source.documentRef[key] === ref[key])) return false;
  const a = source.transform, b = context.transform;
  return a.inputWidth === b.inputWidth && a.inputHeight === b.inputHeight && ['left', 'top', 'right', 'bottom'].every(key => a.sourceBounds[key] === b.sourceBounds[key]);
}
function createCapabilityService({ assets, jobs, provider, bridge, recipes }) {
  const executions = new Map(), controllers = new Map(), placements = new Map();
  let closing = false;
  const ready = Promise.resolve().then(() => jobs.recover());
  function hostStatus() { return bridge.status(); }
  async function host(name, args, options) {
    invariant(hostStatus().connected, 'HOST_UNAVAILABLE', 'Photoshop is not connected', 503);
    validateSchema(args, hostOperations[name]);
    return bridge.request(name, args, options);
  }
  async function inputsFor(snapshot) {
    const context = snapshot.context;
    const base = await assets.read(context.baseAssetId);
    invariant(sameProvenance(base.asset, context, 'input'), 'ASSET_CONTEXT_CONFLICT', 'Source asset belongs to a different capture; capture the source again', 409);
    invariant(base.asset.width === context.transform.inputWidth && base.asset.height === context.transform.inputHeight, 'ASSET_CONTEXT_CONFLICT', 'Source pixels no longer match capture dimensions', 409);
    const mask = context.selectionMaskAssetId ? await assets.read(context.selectionMaskAssetId) : undefined;
    if (mask) invariant(sameProvenance(mask.asset, context, 'mask') && mask.asset.width === base.asset.width && mask.asset.height === base.asset.height, 'ASSET_CONTEXT_CONFLICT', 'Mask provenance or dimensions do not match source pixels', 409);
    const refs = [];
    for (const ref of context.refs || []) refs.push({ ...await assets.read(ref.assetId), role: ref.role });
    return { base, mask, refs };
  }
  async function discover() {
    await ready; const backend = provider.describe(), photoshop = hostStatus();
    return { schemaVersion: 1, capabilities: capabilityDefinitions.map(def => ({ ...clone(def), available: def.backend === 'gemini' ? backend.configured : photoshop.connected })), provider: backend, photoshop, limits: { capturePixels: 8000000, imageBytes: 32 * 1024 * 1024, placement: clone(placementLimits) }, hostAcceptance: 'requires-live-validation' };
  }
  async function capture(args) {
    await ready;
    const value = await host('studio_capture', args);
    invariant(value.ok && value.image && value.documentRef && value.scope === args.scope && value.documentRef.documentId === args.documentId, 'HOST_PROTOCOL_ERROR', 'Photoshop returned an invalid capture', 502);
    const context = { documentRef: value.documentRef, scope: value.scope, transform: value.transform, refs: [], preserve: [], settings: { autoApply: false, groupResults: false, returnType: 'new-layer' } };
    validateContext(context);
    invariant(value.scope !== 'selection' || value.mask, 'MASK_REQUIRED', 'Photoshop did not return a real selection mask');
    const source = { documentRef: value.documentRef, scope: value.scope, transform: value.transform };
    const base = await assets.put({ data: decodeImage(value.image), mimeType: value.image.mimeType, purpose: 'input', width: value.image.width, height: value.image.height, colorSpace: 'sRGB', bitDepth: 8, source });
    invariant(base.width === value.transform.inputWidth && base.height === value.transform.inputHeight, 'HOST_PROTOCOL_ERROR', 'Capture transform does not match pixels', 502);
    context.baseAssetId = base.assetId;
    if (value.mask) {
      const mask = await assets.put({ data: decodeImage(value.mask), mimeType: value.mask.mimeType, purpose: 'mask', width: value.mask.width, height: value.mask.height, colorSpace: 'Gray', bitDepth: 8, source });
      invariant(mask.width === base.width && mask.height === base.height, 'HOST_PROTOCOL_ERROR', 'Capture mask does not match pixels', 502);
      context.selectionMaskAssetId = mask.assetId;
    }
    return validateContext(context);
  }
  async function importAsset(input) {
    await ready;
    return assets.put({ data: decodeImage(input), mimeType: input.mimeType, purpose: 'reference', source: { kind: 'user-import' } });
  }
  async function observe({ tool, arguments: args = {} }) {
    await ready;
    invariant(['photoshop_capabilities', 'photoshop_get_document', 'photoshop_list_layers', 'photoshop_get_layer', 'photoshop_get_selection', 'photoshop_render_preview', 'photoshop_select_layers'].includes(tool), 'UNKNOWN_OPERATION', 'Unsupported observation operation', 404);
    return bridge.request(tool, args);
  }
  async function listRecipes(input = {}) { await ready; invariant(recipes, 'RECIPE_UNAVAILABLE', 'Recipe catalog is not available', 503); return recipes.list(input); }
  async function getRecipe(recipeId) { await ready; invariant(recipes, 'RECIPE_UNAVAILABLE', 'Recipe catalog is not available', 503); return recipes.get(recipeId); }
  async function loadRecipe(input) {
    await ready; invariant(recipes, 'RECIPE_UNAVAILABLE', 'Recipe catalog is not available', 503);
    const draft = await jobs.getDraft(input.draftId);
    invariant(draft.capabilityId === 'image.edit', 'INVALID_INPUT', 'Recipes require an image editing draft');
    invariant(!recipes.get(input.recipeId).requiresReferenceMapping || Array.isArray(input.refs), 'REFERENCE_REQUIRED', 'Map each recipe reference explicitly to a managed asset');
    const compiled = recipes.compile({ recipeId: input.recipeId, values: input.values, userText: input.userText, refs: input.refs === undefined ? draft.context && draft.context.refs || [] : input.refs });
    const patch = { draftId: input.draftId, expectedRevision: input.expectedRevision, source: input.source || 'ui', params: { prompt: compiled.prompt, recipe: compiled.recipe } };
    if (compiled.refs && compiled.refs.length) {
      invariant(draft.context, 'CONTEXT_REQUIRED', 'Capture the source before assigning recipe references');
      for (const ref of compiled.refs) await assets.get(ref.assetId);
      patch.context = { ...draft.context, refs: compiled.refs };
    } else if (input.refs && draft.context) patch.context = { ...draft.context, refs: [] };
    return jobs.updateDraft(patch);
  }
  async function finishFailure(jobId, error) {
    const job = await jobs.getJob(jobId);
    if (['cancelled', 'succeeded', 'failed', 'recovery-required'].includes(job.status)) return;
    const uncertain = closing || error.code === 'PROVIDER_UNCERTAIN' || uncertainHost(error);
    await jobs.transition(jobId, uncertain ? 'recovery-required' : error.code === 'CANCELLED' ? 'cancelled' : 'failed', { error: publicError(error) });
  }
  async function persistReceipt(jobId, receipt) {
    try { return await jobs.setPlacement(jobId, { status: 'applied', receipt }); }
    catch (_) {
      const error = new DomainError('HOST_UNCERTAIN', 'Photoshop changed the document but its receipt could not be durably recorded; inspect before any further write', 503, { mutationId: receipt.mutationId });
      // Preserve recoverable evidence if a second atomic write is possible. If
      // storage is still unavailable, the durable applying state forbids replay.
      try { await jobs.setPlacement(jobId, { status: 'rollback-conflict', receipt, error: publicError(error) }); } catch (_) {}
      throw error;
    }
  }
  async function runJob(job) {
    const controller = new AbortController(); controllers.set(job.jobId, controller);
    try {
      if (closing || (await jobs.getJob(job.jobId)).status !== 'queued') return;
      await jobs.transition(job.jobId, 'running');
      if (job.snapshot.capabilityId === 'ps.layer.update') {
        const requestId = 'native.' + job.jobId, mutationId = randomUUID();
        await jobs.setPlacement(job.jobId, { status: 'queued', requestId });
        await jobs.setPlacement(job.jobId, { status: 'applying' });
        try {
          const result = await host('studio_edit_layer', { documentRef: job.snapshot.context.documentRef, jobId: job.jobId, mutationId, ...job.snapshot.params }, { signal: controller.signal });
          invariant(result.receipt && result.receipt.mutationId === mutationId && result.receipt.jobId === job.jobId, 'HOST_UNCERTAIN', 'Photoshop mutation receipt is missing or mismatched', 502);
          await persistReceipt(job.jobId, result.receipt);
        } catch (error) {
          await jobs.setPlacement(job.jobId, { status: uncertainHost(error) ? 'rollback-conflict' : 'failed', error: publicError(error) });
          throw error;
        }
        if ((await jobs.getJob(job.jobId)).status === 'running') await jobs.transition(job.jobId, 'succeeded');
        return;
      }
      validateGenerationPlacement(job.snapshot);
      const inputs = await inputsFor(job.snapshot);
      if (controller.signal.aborted || (await jobs.getJob(job.jobId)).status === 'cancelled') return;
      const result = await provider.generate({ jobId: job.jobId, requestId: job.requestId, params: job.snapshot.params, context: job.snapshot.context, inputs }, { signal: controller.signal });
      invariant(result.images && result.images.length > 0 && result.images.length <= 8, 'PROVIDER_REJECTED', 'Provider returned no usable image or too many results', 502);
      for (const image of result.images) {
        const asset = await assets.put({ data: image.data, mimeType: image.mimeType, ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}), purpose: 'result', source: { jobId: job.jobId, provider: result.provider } });
        await jobs.addResults(job.jobId, [{ resultId: randomUUID(), assetId: asset.assetId, provider: result.provider }]);
      }
      // Some providers ignore abort. Retain their late images without reviving or auto-applying.
      if ((await jobs.getJob(job.jobId)).status !== 'running') return;
      await jobs.transition(job.jobId, 'succeeded', { provider: result.provider });
      if (!closing && job.snapshot.context.settings && job.snapshot.context.settings.autoApply) {
        const current = await jobs.getJob(job.jobId);
        await apply({ jobId: job.jobId, resultId: current.results[0].resultId, requestId: 'auto.' + job.jobId });
      }
    } catch (error) {
      await finishFailure(job.jobId, error);
    } finally { controllers.delete(job.jobId); }
  }
  async function run(input) {
    await ready; invariant(!closing, 'SERVICE_CLOSING', 'Service is stopping', 503);
    const created = await jobs.createJob(input);
    if (!created.duplicate) {
      const execution = Promise.resolve().then(() => runJob(created.job));
      executions.set(created.job.jobId, execution);
      execution.catch(() => { /* Store errors fail closed; recovery inspects persisted state. */ }).finally(() => executions.delete(created.job.jobId));
    }
    return created;
  }
  async function cancel(jobId) {
    await ready;
    const job = await jobs.cancel(jobId);
    if (job.status === 'cancelled' && controllers.has(jobId)) controllers.get(jobId).abort();
    return job;
  }
  async function apply(input) {
    await ready; id(input.jobId); id(input.resultId); id(input.requestId, 'requestId');
    invariant(!closing, 'SERVICE_CLOSING', 'Service is stopping', 503);
    if (placements.has(input.jobId)) {
      const active = placements.get(input.jobId);
      invariant(active.requestId === input.requestId && active.resultId === input.resultId, 'PLACEMENT_CONFLICT', 'Another placement is in progress', 409);
      return active.promise;
    }
    const promise = (async () => {
      const job = await jobs.getJob(input.jobId);
      invariant(job.status === 'succeeded', 'STATE_CONFLICT', 'Only a successful job can be placed', 409);
      const result = job.results.find(r => r.resultId === input.resultId);
      invariant(result, 'RESULT_NOT_FOUND', 'Result does not belong to this job', 404);
      if (['applied', 'rolled-back'].includes(job.placement.status)) {
        invariant(job.placement.requestId === input.requestId && job.placement.receipt.resultId === input.resultId, 'PLACEMENT_CONFLICT', 'This job has already been placed', 409);
        return job;
      }
      invariant(['not-requested', 'failed'].includes(job.placement.status), 'PLACEMENT_CONFLICT', 'Placement outcome requires inspection before another write', 409);
      await inputsFor(job.snapshot);
      const context = job.snapshot.context, image = await assets.read(result.assetId);
      const mask = context.selectionMaskAssetId ? await assets.read(context.selectionMaskAssetId) : null;
      const mutationId = randomUUID();
      const queued = await jobs.setPlacement(job.jobId, { status: 'queued', requestId: input.requestId });
      invariant(queued.placement.status === 'queued' && queued.placement.requestId === input.requestId, 'PLACEMENT_CONFLICT', 'Placement request has already been handled', 409);
      try {
        validatePlacementSettings(context.settings);
        validatePlacementImage(image);
        const applying = await jobs.setPlacement(job.jobId, { status: 'applying' });
        invariant(applying.placement.status === 'applying', 'PLACEMENT_CONFLICT', 'Placement cannot be dispatched in this state', 409);
        const response = await host('studio_apply_result', { documentRef: context.documentRef, jobId: job.jobId, mutationId, image: asImage(image), ...(mask ? { mask: asImage(mask) } : {}), transform: context.transform, settings: context.settings || {} });
        invariant(response.receipt && response.receipt.mutationId === mutationId && response.receipt.jobId === job.jobId, 'HOST_UNCERTAIN', 'Photoshop placement receipt is missing or mismatched', 502);
        return await persistReceipt(job.jobId, { ...response.receipt, resultId: input.resultId });
      } catch (error) {
        return jobs.setPlacement(job.jobId, { status: uncertainHost(error) ? 'rollback-conflict' : 'failed', error: publicError(error) });
      }
    })();
    placements.set(input.jobId, { requestId: input.requestId, resultId: input.resultId, promise });
    try { return await promise; } finally { placements.delete(input.jobId); }
  }
  async function rollback({ jobId }) {
    await ready; id(jobId);
    invariant(!placements.has(jobId), 'PLACEMENT_CONFLICT', 'A placement is still in progress', 409);
    const job = await jobs.getJob(jobId);
    if (job.placement.status === 'rolled-back') return job;
    invariant(job.placement.status === 'applied' && job.placement.receipt, 'STATE_CONFLICT', 'This job has no reversible mutation', 409);
    try {
      const { resultId, ...hostReceipt } = job.placement.receipt;
      const result = await host('studio_rollback', { receipt: hostReceipt });
      invariant(result.receipt && result.receipt.mutationId === job.placement.receipt.mutationId && result.receipt.rollbackStatus === 'rolled-back', 'ROLLBACK_CONFLICT', 'Photoshop did not confirm rollback', 409);
      return jobs.setPlacement(jobId, { status: 'rolled-back' });
    } catch (error) {
      return jobs.setPlacement(jobId, { status: 'rollback-conflict', error: publicError(error) });
    }
  }
  async function delegated(method, ...args) { await ready; return jobs[method](...args); }
  async function close() { closing = true; for (const controller of controllers.values()) controller.abort(); await Promise.allSettled([...executions.values()]); }
  return { discover, capture, importAsset, observe, listRecipes, getRecipe, loadRecipe, run, cancel, apply, rollback, ready, close, readAsset: async assetId => { await ready; return assets.read(assetId); },
    createDraft: input => delegated('createDraft', input), getDraft: draftId => delegated('getDraft', draftId), listDrafts: () => delegated('listDrafts'), updateDraft: input => delegated('updateDraft', input), getJob: jobId => delegated('getJob', jobId), listJobs: () => delegated('listJobs'),
    waitForIdle: async () => { await ready; await Promise.allSettled([...executions.values()]); },
  };
}
module.exports = { createCapabilityService, decodeImage };
