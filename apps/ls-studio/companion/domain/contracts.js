'use strict';

// This module is transport-independent. UI and MCP use the same capability service.
class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message); this.name = 'DomainError'; this.code = code; this.status = status;
    if (details !== undefined) this.details = details;
  }
}
function invariant(condition, code, message, status = 400, details) {
  if (!condition) throw new DomainError(code, message, status, details);
}
function object(value, label = 'value') {
  invariant(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'INVALID_INPUT', label + ' must be an object');
  return value;
}
function clone(value) {
  function check(v, depth) {
    invariant(depth <= 32, 'INVALID_INPUT', 'Input nesting exceeds 32 levels');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') { invariant(Number.isFinite(v), 'INVALID_INPUT', 'Numbers must be finite'); return; }
    if (Array.isArray(v)) { v.forEach(item => check(item, depth + 1)); return; }
    object(v);
    for (const [key, child] of Object.entries(v)) {
      invariant(!['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_INPUT', 'Unsafe object key');
      invariant(!/^(api[_-]?key|authorization|password|secret|access[_-]?token)$/i.test(key), 'INVALID_INPUT', 'Credentials belong in provider configuration, not task state');
      check(child, depth + 1);
    }
  }
  check(value, 0); return JSON.parse(JSON.stringify(value));
}
function id(value, label = 'id') {
  invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), 'INVALID_INPUT', label + ' is invalid');
  return value;
}
function schema(properties, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const text = (maxLength = 32000) => ({ type: 'string', maxLength });
const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' };
const integer = { type: 'integer', minimum: 1 };
const rect = schema({ left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' } }, ['left', 'top', 'right', 'bottom']);
const documentRefSchema = schema({ runtimeId: identifier, documentToken: identifier, documentId: integer, historyStateId: { type: ['integer', 'string', 'null'] }, width: integer, height: integer, name: text(1000) }, ['runtimeId', 'documentToken', 'documentId', 'historyStateId', 'width', 'height']);
const contextSchema = schema({
  documentRef: documentRefSchema, scope: { enum: ['selection', 'document'] }, baseAssetId: identifier,
  selectionMaskAssetId: identifier, refs: { type: 'array', maxItems: 16, items: schema({ assetId: identifier, role: { enum: ['reference', 'identity', 'style', 'structure'] } }, ['assetId', 'role']) },
  preserve: { type: 'array', maxItems: 32, items: text(1000) },
  settings: schema({ autoApply: { type: 'boolean' }, groupResults: { type: 'boolean' }, returnType: { enum: ['new-layer'] } }),
  transform: schema({ sourceBounds: rect, inputWidth: integer, inputHeight: integer }, ['sourceBounds', 'inputWidth', 'inputHeight']),
}, ['documentRef', 'scope']);
const capabilityDefinitions = [
  { id: 'image.edit', version: 1, title: '图像编辑', backend: 'gemini', inputSchema: schema({ prompt: text(64000), model: text(200), temperature: { type: 'number', minimum: 0, maximum: 2 }, aspectRatio: { enum: ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '4:5', '5:4'] }, imageSize: { enum: ['1K', '2K', '4K'] } }), outputSchema: { type: 'object', required: ['results'] }, errors: ['PROVIDER_NOT_CONFIGURED', 'PROVIDER_AUTH', 'PROVIDER_RATE_LIMIT', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN', 'CANCELLED'] },
  { id: 'ps.layer.update', version: 1, title: '修改图层属性', backend: 'photoshop', inputSchema: schema({ layerId: integer, changes: schema({ name: text(1000), opacity: { type: 'number', minimum: 0, maximum: 100 }, visible: { type: 'boolean' } }) }), outputSchema: { type: 'object', required: ['receipt'] }, errors: ['HOST_UNAVAILABLE', 'DOCUMENT_CONFLICT', 'HOST_EXECUTION_FAILED', 'ROLLBACK_CONFLICT'] },
];

function validateSchema(value, rule, label = 'input') {
  if (rule.enum) invariant(rule.enum.includes(value), 'INVALID_INPUT', label + ' is not a supported value');
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : Number.isInteger(value) ? 'integer' : typeof value;
  if (rule.type) invariant([].concat(rule.type).some(t => t === type || (t === 'number' && type === 'integer')), 'INVALID_INPUT', label + ' has an invalid type');
  if (type === 'object') {
    object(value, label);
    for (const key of rule.required || []) invariant(Object.hasOwn(value, key), 'INVALID_INPUT', label + '.' + key + ' is required');
    for (const [key, child] of Object.entries(value)) {
      const sub = (rule.properties && rule.properties[key]) || (rule.additionalProperties && typeof rule.additionalProperties === 'object' ? rule.additionalProperties : undefined);
      invariant(sub || rule.additionalProperties !== false, 'INVALID_INPUT', label + '.' + key + ' is not supported');
      if (sub) validateSchema(child, sub, label + '.' + key);
    }
  }
  if (type === 'array') {
    invariant(rule.maxItems == null || value.length <= rule.maxItems, 'INVALID_INPUT', label + ' contains too many items');
    invariant(rule.minItems == null || value.length >= rule.minItems, 'INVALID_INPUT', label + ' contains too few items');
    if (rule.items) value.forEach((item, i) => validateSchema(item, rule.items, label + '[' + i + ']'));
  }
  if (type === 'string') {
    invariant(rule.maxLength == null || value.length <= rule.maxLength, 'INVALID_INPUT', label + ' is too long');
    invariant(rule.minLength == null || value.length >= rule.minLength, 'INVALID_INPUT', label + ' is empty');
    invariant(!rule.pattern || new RegExp(rule.pattern).test(value), 'INVALID_INPUT', label + ' has invalid characters');
  }
  if (type === 'number' || type === 'integer') invariant(Number.isFinite(value) && (rule.minimum == null || value >= rule.minimum) && (rule.maximum == null || value <= rule.maximum), 'INVALID_INPUT', label + ' is outside the supported range');
  return value;
}
function capability(capabilityId) {
  const found = capabilityDefinitions.find(c => c.id === capabilityId);
  invariant(found, 'UNKNOWN_CAPABILITY', 'Unsupported capability: ' + capabilityId, 404); return clone(found);
}
function validateContext(context) {
  if (context == null) return null;
  validateSchema(context, contextSchema, 'context');
  if (context.transform) {
    const b = context.transform.sourceBounds, d = context.documentRef;
    invariant(b.left >= 0 && b.top >= 0 && b.right > b.left && b.bottom > b.top && b.right <= d.width && b.bottom <= d.height, 'INVALID_INPUT', 'Capture bounds must fit the source document');
  }
  return clone(context);
}
function validateDraft(input) {
  object(input); const def = capability(input.capabilityId);
  validateSchema(input.params || {}, def.inputSchema, 'params');
  invariant(input.source == null || ['ui', 'agent', 'system'].includes(input.source), 'INVALID_INPUT', 'Unknown update source');
  return { capabilityId: def.id, capabilityVersion: def.version, params: clone(input.params || {}), context: validateContext(input.context), source: input.source || 'ui' };
}
function validateRunSnapshot(snapshot) {
  const draft = validateDraft(snapshot), c = draft.context;
  invariant(c && c.documentRef.historyStateId != null, 'CONTEXT_REQUIRED', 'Capture the source document before running');
  if (draft.capabilityId === 'image.edit') {
    invariant(typeof draft.params.prompt === 'string' && draft.params.prompt.trim(), 'PROMPT_REQUIRED', 'Enter an editing instruction');
    invariant(c.baseAssetId && c.transform, 'CONTEXT_REQUIRED', 'Production source pixels are required');
    invariant(c.scope !== 'selection' || c.selectionMaskAssetId, 'MASK_REQUIRED', 'A real selection mask is required');
  } else {
    invariant(draft.params.layerId && draft.params.changes && Object.keys(draft.params.changes).length, 'INVALID_INPUT', 'Choose an existing layer and at least one property');
  }
  return draft;
}
const jobTransitions = {
  queued: ['running', 'cancelled', 'recovery-required'], running: ['succeeded', 'failed', 'cancelled', 'recovery-required'],
  succeeded: [], failed: [], cancelled: [], 'recovery-required': ['cancelled'],
};
const placementTransitions = {
  'not-requested': ['queued'], queued: ['applying', 'failed'], applying: ['applied', 'failed', 'rollback-conflict'],
  applied: ['rolled-back', 'rollback-conflict'], failed: ['queued'], 'rollback-conflict': [], 'rolled-back': [],
};
function assertTransition(from, to, kind = 'job') {
  const transitions = kind === 'placement' ? placementTransitions : jobTransitions;
  invariant(transitions[from] && (from === to || transitions[from].includes(to)), 'STATE_CONFLICT', 'Invalid ' + kind + ' transition: ' + from + ' → ' + to, 409);
}
function publicError(error) {
  return { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR', message: error instanceof DomainError ? error.message : 'Operation failed; see the local diagnostic log', ...(error instanceof DomainError && error.details !== undefined ? { details: clone(error.details) } : {}) };
}
const hostOperations = {
  studio_capture: schema({ documentId: integer, scope: { enum: ['selection', 'document'] } }, ['documentId', 'scope']),
  studio_edit_layer: schema({ documentRef: documentRefSchema, jobId: identifier, mutationId: identifier, layerId: integer, changes: capabilityDefinitions[1].inputSchema.properties.changes }, ['documentRef', 'jobId', 'mutationId', 'layerId', 'changes']),
  studio_apply_result: schema({ documentRef: documentRefSchema, jobId: identifier, mutationId: identifier, image: schema({ base64: text(96 * 1024 * 1024), mimeType: { enum: ['image/png', 'image/jpeg', 'image/webp'] }, width: integer, height: integer }, ['base64', 'mimeType', 'width', 'height']), mask: { type: 'object' }, transform: contextSchema.properties.transform, settings: contextSchema.properties.settings }, ['documentRef', 'jobId', 'mutationId', 'image', 'transform']),
  studio_rollback: schema({ receipt: { type: 'object' } }, ['receipt']),
};
capabilityDefinitions[0].inputSchema.properties.recipe = schema({ recipeId: identifier, sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, values: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } } }, ['recipeId', 'sourceHash', 'values']);
module.exports = { DomainError, invariant, object, clone, id, schema, identifier, integer, contextSchema, documentRefSchema, capabilityDefinitions, capability, validateSchema, validateContext, validateDraft, validateRunSnapshot, assertTransition, jobTransitions, placementTransitions, publicError, hostOperations };
