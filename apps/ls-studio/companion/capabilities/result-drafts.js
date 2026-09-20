'use strict';

const { invariant, clone, id, capability, validateRunSnapshot } = require('../domain/contracts');

function modelName(value) { return typeof value === 'string' ? value.trim().replace(/^models\//, '') : ''; }
function inheritModel(snapshot, job) {
  const recorded = job.provider && job.provider.model;
  if (recorded === undefined) return;
  const model = modelName(recorded);
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model), 'MODEL_CONTEXT_CONFLICT', 'The historical provider model record is invalid; inspect this job before creating a revision', 409);
  invariant(snapshot.params.model === undefined || modelName(snapshot.params.model) === model, 'MODEL_CONTEXT_CONFLICT', 'The historical requested model conflicts with its recorded provider model; inspect this job before creating a revision', 409);
  if (snapshot.params.model === undefined) snapshot.params.model = model;
}

// A result is a visual reference, never a replacement for a PS capture. Keeping
// the original context preserves its document/mask provenance for later runs.
function createResultDrafts({ assets, jobs, provider, inputsFor }) {
  return async function deriveDraft(input) {
    id(input.jobId, 'jobId');
    invariant(['original', 'candidate-reference'].includes(input.mode), 'INVALID_INPUT', 'Choose original inputs or a candidate reference');
    invariant(input.mode === 'candidate-reference' ? typeof input.resultId === 'string' : input.resultId === undefined, 'INVALID_INPUT', 'A candidate result is required only for candidate-reference mode');
    const job = await jobs.getJob(input.jobId), snapshot = clone(job.snapshot);
    invariant(snapshot.capabilityId === 'image.edit', 'CAPABILITY_CONFLICT', 'Only image editing jobs can create a revision draft');
    invariant(snapshot.capabilityVersion === capability(snapshot.capabilityId).version, 'CAPABILITY_VERSION_CONFLICT', 'This historical capability version cannot be edited by the current service');
    validateRunSnapshot(snapshot);
    inheritModel(snapshot, job);
    // Read verifies existence, integrity and original capture provenance before
    // creating anything. Current drafts and the current PS document are unused.
    const inputs = await inputsFor(snapshot);
    if (input.mode === 'candidate-reference') {
      id(input.resultId, 'resultId');
      const result = job.results.find(item => item.resultId === input.resultId);
      invariant(result && result.jobId === job.jobId, 'RESULT_NOT_FOUND', 'The selected candidate does not belong to this job', 404);
      const candidate = await assets.read(result.assetId);
      invariant(candidate.asset.purpose === 'result' && candidate.asset.source && candidate.asset.source.jobId === job.jobId, 'ASSET_CONTEXT_CONFLICT', 'The candidate asset does not belong to this job', 409);
      const refs = snapshot.context.refs || [];
      if (!refs.some(ref => ref.assetId === result.assetId && ref.role === 'reference')) {
        const model = modelName(snapshot.params.model);
        invariant(model, 'REFERENCE_LIMIT_UNKNOWN', 'The historical model is not recorded. Create a draft from original inputs, then explicitly choose a model and review its reference budget');
        const description = provider.describe({ model }), limits = description.limits || {};
        invariant(model === description.model && Number.isInteger(limits.inputImages) && limits.inputImages > 0 && Number.isFinite(limits.inputBytes) && limits.inputBytes > 0, 'REFERENCE_LIMIT_UNKNOWN', 'This adapter cannot confirm the historical model reference budget. Create a draft from original inputs, then review the model and references before adding a candidate');
        invariant(refs.length < 16 && 1 + (inputs.mask ? 1 : 0) + refs.length + 1 <= limits.inputImages, 'REFERENCE_LIMIT', 'There is no room for this candidate reference. Create a draft from original inputs and remove a reference or choose a model with a larger input budget');
        const bytes = [inputs.base, ...(inputs.mask ? [inputs.mask] : []), ...inputs.refs, candidate].reduce((total, item) => total + item.data.length, 0);
        invariant(bytes <= limits.inputBytes, 'REFERENCE_LIMIT', 'The candidate would exceed the model image byte budget. Create a draft from original inputs and review its references');
        snapshot.context.refs = refs.concat([{ assetId: result.assetId, role: 'reference' }]);
      }
    }
    // Preserve the compiled prompt and recipe sourceHash/values; do not recompile
    // against a possibly changed recipe catalog or start any execution here.
    return jobs.createDraft({ capabilityId: snapshot.capabilityId, params: snapshot.params, context: snapshot.context, source: input.source || 'ui' });
  };
}

module.exports = { createResultDrafts };
