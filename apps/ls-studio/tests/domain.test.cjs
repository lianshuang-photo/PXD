const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDraft, validateRunSnapshot, validateSchema, hostOperations, clone, assertTransition } = require('../companion/domain/contracts');
const { draft } = require('../companion/domain/fixtures');
test('drafts can be incomplete but execution requires explicit source scope and true mask', () => {
  assert.equal(validateDraft({capabilityId:'image.edit'}).context, null);
  assert.throws(() => validateRunSnapshot({capabilityId:'image.edit'}), {code:'CONTEXT_REQUIRED'});
  const next = clone(draft); delete next.context.selectionMaskAssetId;
  assert.throws(() => validateRunSnapshot(next), {code:'MASK_REQUIRED'});
  next.context.scope = 'document'; assert.doesNotThrow(() => validateRunSnapshot(next));
});
test('document bounds, unknown parameters and task credentials fail before persistence', () => {
  const next = clone(draft); next.context.transform.sourceBounds.right = 3;
  assert.throws(() => validateDraft(next), {code:'INVALID_INPUT'});
  assert.throws(() => validateDraft({...draft,params:{prompt:'edit',secret:'test'}}), {code:'INVALID_INPUT'});
  assert.throws(() => clone({settings:{apiKey:'test'}}), {code:'INVALID_INPUT'});
  assert.throws(() => validateDraft({...draft,params:{temperature:NaN}}), {code:'INVALID_INPUT'});
});
test('late provider completion cannot revive cancelled or uncertain jobs; placement is separate', () => {
  assert.throws(() => assertTransition('cancelled','succeeded'), {code:'STATE_CONFLICT'});
  assert.throws(() => assertTransition('recovery-required','running'), {code:'STATE_CONFLICT'});
  assert.doesNotThrow(() => assertTransition('applying','failed','placement'));
});
test('native drafts can clear a stale layer target while execution and host requests reject it', () => {
  const next = { capabilityId: 'ps.layer.update', context: clone(draft.context), params: { layerId: null, changes: { opacity: 50 } } };
  assert.equal(validateDraft(next).params.layerId, null);
  assert.throws(() => validateRunSnapshot(next), { code: 'INVALID_INPUT' });
  assert.throws(() => validateSchema({ documentRef: next.context.documentRef, jobId: 'job', mutationId: 'mutation', layerId: null, changes: { opacity: 50 } }, hostOperations.studio_edit_layer), { code: 'INVALID_INPUT' });
});
