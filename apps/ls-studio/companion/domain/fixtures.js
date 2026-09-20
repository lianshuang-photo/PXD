'use strict';
const documentRef = { runtimeId: 'host-fixture-1', documentToken: 'document-fixture-1', documentId: 1, historyStateId: 4, width: 2, height: 2, name: 'Fixture' };
const context = { documentRef, scope: 'selection', baseAssetId: 'asset-fixture-base', selectionMaskAssetId: 'asset-fixture-mask', refs: [], preserve: ['identity'], settings: { autoApply: false, groupResults: false, returnType: 'new-layer' }, transform: { sourceBounds: { left: 0, top: 0, right: 2, bottom: 2 }, inputWidth: 2, inputHeight: 2 } };
module.exports = { documentRef, context, draft: { capabilityId: 'image.edit', params: { prompt: 'Keep the person; clean stray hair.' }, context, source: 'ui' } };
