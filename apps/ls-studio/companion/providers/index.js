'use strict';

const { DomainError, invariant, object, id, validateRunSnapshot } = require('../domain/contracts');

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '4:5', '5:4'];
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PROVIDER_ERROR = Symbol('providerError');
const LIMITS = Object.freeze({
  requestBytes: 20_000_000,
  inputBytes: 14 * 1024 * 1024,
  responseBytes: 96 * 1024 * 1024,
  outputImageBytes: 32 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  outputImages: 4,
  pixelsPerInput: 64 * 1024 * 1024,
});
const BLOCK_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']);

function providerError(code, message, status, reason, extra = {}) {
  const error = new DomainError(code, message, status, { provider: 'gemini', reason, automaticRetry: false, ...extra });
  error[PROVIDER_ERROR] = true;
  return error;
}
function uncertain(reason, extra = {}, status = 502) {
  return providerError('PROVIDER_UNCERTAIN', 'The image service outcome is uncertain. Inspect the job before manually submitting another paid request.', status, reason, extra);
}
function cancelled() {
  return providerError('CANCELLED', 'Image generation was cancelled. The remote service may still finish and charge for an already submitted request.', 499, 'CANCELLED');
}
function normalizeModel(value, apiKey) {
  invariant(typeof value === 'string', 'PROVIDER_NOT_CONFIGURED', 'Configure a Gemini image model', 503);
  const model = value.trim().replace(/^models\//, '');
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model) && (!apiKey || !model.includes(apiKey)), 'PROVIDER_NOT_CONFIGURED', 'The configured Gemini model name is invalid', 503);
  return model;
}
function profileFor(model) {
  if (model === 'gemini-2.5-flash-image' || model === 'gemini-2.5-flash-image-preview') {
    return { known: true, aspectRatios: ASPECT_RATIOS, imageSizes: [], maxInputImages: 3 };
  }
  if (model === 'gemini-3-pro-image-preview') {
    return { known: true, aspectRatios: ASPECT_RATIOS, imageSizes: ['1K', '2K', '4K'], maxInputImages: 14 };
  }
  return { known: false, aspectRatios: [], imageSizes: [], maxInputImages: 3 };
}
function configuration(env, config, { allowMissingKey = false } = {}) {
  invariant(env && typeof env === 'object' && !Array.isArray(env), 'PROVIDER_NOT_CONFIGURED', 'The provider environment must be an object', 503);
  if (config !== undefined) object(config, 'config');
  const read = (name, variable, fallback) => config && Object.hasOwn(config, name) ? config[name] : env[variable] ?? fallback;
  const key = read('apiKey', 'PXDLS_GEMINI_API_KEY', '');
  invariant(typeof key === 'string' && ((allowMissingKey && key.trim() === '') || /^[\x21-\x7e]{1,4096}$/.test(key.trim())), 'PROVIDER_NOT_CONFIGURED', 'Configure a Gemini API key to enable image generation', 503);
  const apiKey = key.trim();
  const model = normalizeModel(read('model', 'PXDLS_GEMINI_MODEL', DEFAULT_MODEL), apiKey);
  const baseUrl = read('baseUrl', 'PXDLS_GEMINI_BASE_URL', DEFAULT_BASE_URL);
  let url;
  try { url = new URL(baseUrl); } catch { /* Return only a fixed configuration message. */ }
  invariant(typeof baseUrl === 'string' && url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.pathname.includes(':') && (!apiKey || !baseUrl.includes(apiKey)), 'PROVIDER_NOT_CONFIGURED', 'The Gemini base URL must be an HTTPS API root without credentials, query parameters or fragments', 503);
  let apiRoot = url.href.replace(/\/+$/, '');
  if (!/\/v1(?:beta)?$/.test(apiRoot)) apiRoot += '/v1beta';
  const timeoutValue = read('timeoutMs', 'PXDLS_GEMINI_TIMEOUT_MS', 180_000);
  const timeoutMs = typeof timeoutValue === 'string' && /^\d+$/.test(timeoutValue) ? Number(timeoutValue) : timeoutValue;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000, 'PROVIDER_NOT_CONFIGURED', 'Gemini timeout must be between 1 and 600000 milliseconds', 503);
  return { apiKey, model, apiRoot, timeoutMs };
}

function matchesSignature(data, mimeType) {
  if (mimeType === 'image/png') return data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR';
  if (mimeType === 'image/jpeg') return data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (mimeType === 'image/webp') return data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
function validateImage(input, label) {
  object(input, label); object(input.asset, label + '.asset');
  id(input.asset.assetId, label + '.asset.assetId');
  invariant(Buffer.isBuffer(input.data) && input.data.length > 0 && input.data.length <= LIMITS.inputBytes, 'INVALID_INPUT', label + ' must contain bounded image bytes');
  invariant(MIME_TYPES.includes(input.asset.mimeType) && matchesSignature(input.data, input.asset.mimeType), 'INVALID_INPUT', label + ' must be a PNG, JPEG or WebP matching its MIME type');
  const { width, height } = input.asset;
  invariant(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= LIMITS.pixelsPerInput, 'INVALID_INPUT', label + ' dimensions exceed the image input limits');
}
function buildRequest(input, config) {
  object(input, 'generation input'); id(input.jobId, 'jobId'); id(input.requestId, 'requestId');
  const draft = validateRunSnapshot({ capabilityId: 'image.edit', params: input.params, context: input.context });
  const { params, context } = draft;
  let model = config.model;
  if (params.model !== undefined) {
    try { model = normalizeModel(params.model, config.apiKey); }
    catch { throw new DomainError('INVALID_INPUT', 'The requested Gemini model name is invalid'); }
  }
  const profile = profileFor(model);
  invariant(params.aspectRatio === undefined || params.aspectRatio === 'auto' || profile.aspectRatios.includes(params.aspectRatio), 'INVALID_INPUT', 'This model does not support the requested aspectRatio setting');
  invariant(params.imageSize === undefined || profile.imageSizes.includes(params.imageSize), 'INVALID_INPUT', 'This model does not support the requested imageSize setting');
  const { inputs } = input;
  object(inputs, 'inputs');
  validateImage(inputs.base, 'source image');
  invariant(inputs.base.asset.assetId === context.baseAssetId, 'INVALID_INPUT', 'Source image does not match the captured context');
  invariant(inputs.base.asset.width === context.transform.inputWidth && inputs.base.asset.height === context.transform.inputHeight, 'INVALID_INPUT', 'Source image dimensions do not match the captured transform');
  invariant(Array.isArray(inputs.refs), 'INVALID_INPUT', 'inputs.refs must be an array');
  const contextRefs = context.refs || [];
  invariant(inputs.refs.length === contextRefs.length, 'INVALID_INPUT', 'Reference images do not match the captured context');
  invariant(Boolean(inputs.mask) === Boolean(context.selectionMaskAssetId), 'INVALID_INPUT', 'Selection mask does not match the captured context');
  if (inputs.mask) {
    validateImage(inputs.mask, 'selection mask');
    invariant(inputs.mask.asset.assetId === context.selectionMaskAssetId && inputs.mask.asset.mimeType === 'image/png', 'INVALID_INPUT', 'Selection mask must match the captured PNG mask');
    invariant(inputs.mask.asset.width === inputs.base.asset.width && inputs.mask.asset.height === inputs.base.asset.height, 'INVALID_INPUT', 'Selection mask and source dimensions must match');
  }
  inputs.refs.forEach((reference, i) => {
    validateImage(reference, 'reference image');
    invariant(reference.asset.assetId === contextRefs[i].assetId && reference.role === contextRefs[i].role, 'INVALID_INPUT', 'Reference image identity or role does not match the captured context');
  });
  const imageInputs = [inputs.base, ...(inputs.mask ? [inputs.mask] : []), ...inputs.refs];
  invariant(imageInputs.length <= profile.maxInputImages, 'INVALID_INPUT', 'The number of source, mask and reference images exceeds this model adapter limit');
  invariant(imageInputs.reduce((sum, item) => sum + item.data.length, 0) <= LIMITS.inputBytes, 'INVALID_INPUT', 'Combined input images exceed the provider byte limit');

  const parts = [
    { text: 'Edit SOURCE_IMAGE according to the user instruction. Return the edited image. Treat references as visual guidance with their labeled roles. Preserve all listed constraints.' },
    { text: 'User instruction:\n' + params.prompt },
    { text: 'Preserve constraints:\n' + ((context.preserve || []).map((constraint, i) => (i + 1) + '. ' + constraint).join('\n') || 'Preserve content not addressed by the user instruction.') },
  ];
  const appendImage = (label, entry) => {
    parts.push({ text: label + '\nAsset ID: ' + entry.asset.assetId });
    parts.push({ inlineData: { mimeType: entry.asset.mimeType, data: entry.data.toString('base64') } });
  };
  appendImage('SOURCE_IMAGE: the original pixels to edit.', inputs.base);
  if (inputs.mask) appendImage('EDIT_MASK: aligned 8-bit grayscale selection. White (255) is editable, black (0) is protected, intermediate values are feathered/partial coverage. Keep protected pixels unchanged. Photoshop will enforce this mask during compositing; do not paint the mask into the result.', inputs.mask);
  const roleDescriptions = {
    reference: 'general visual guidance', identity: 'preserve this subject identity',
    style: 'visual style guidance', structure: 'composition and structural guidance',
  };
  inputs.refs.forEach((reference, i) => appendImage('REFERENCE_IMAGE ' + (i + 1) + ': role=' + reference.role + '; ' + roleDescriptions[reference.role] + '.', reference));
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  const imageConfig = {};
  if (params.aspectRatio !== undefined && params.aspectRatio !== 'auto') imageConfig.aspectRatio = params.aspectRatio;
  if (params.imageSize !== undefined) imageConfig.imageSize = params.imageSize;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });
  invariant(Buffer.byteLength(body) <= LIMITS.requestBytes, 'INVALID_INPUT', 'The encoded generation request exceeds the provider byte limit');
  return { model, body };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error('Provider operation interrupted')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* Ignore a body already closed by fetch. */ }
}
async function readResponse(response, signal) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > LIMITS.responseBytes) {
    cancelBody(response); throw uncertain('RESPONSE_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    cancelBody(response); throw uncertain('RESPONSE_STREAM_REQUIRED');
  }
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0; let complete = false;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw uncertain('INVALID_RESPONSE');
      bytes += value.byteLength;
      if (bytes > LIMITS.responseBytes) throw uncertain('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new Error('Provider operation interrupted');
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw uncertain('INVALID_RESPONSE'); }
  } finally {
    if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* The stream may already be closed. */ } }
    try { reader.releaseLock(); } catch { /* A pending read may still be cancelling. */ }
  }
}
function httpError(status) {
  if (status === 401 || status === 403) return providerError('PROVIDER_AUTH', 'The image service rejected the configured API key or its permissions', 502, 'AUTH', { httpStatus: status });
  if (status === 429) return providerError('PROVIDER_RATE_LIMIT', 'The image service quota or rate limit was reached. No retry was made.', 429, 'RATE_LIMIT', { httpStatus: status });
  if (status === 408 || status >= 500) return uncertain('HTTP_ERROR', { httpStatus: status });
  return providerError('PROVIDER_REJECTED', 'The image service rejected this request. Check the configured model and supported inputs.', 422, 'HTTP_REJECTION', { httpStatus: status });
}
function parseInlineImage(inline) {
  if (!inline || typeof inline !== 'object' || Array.isArray(inline)) throw uncertain('INVALID_IMAGE');
  const mimeType = inline.mimeType ?? inline.mime_type;
  if (!MIME_TYPES.includes(mimeType) || typeof inline.data !== 'string') throw uncertain('INVALID_IMAGE');
  if (inline.data.length > Math.ceil(LIMITS.outputImageBytes / 3) * 4 + 1024) throw uncertain('OUTPUT_IMAGE_TOO_LARGE');
  const encoded = inline.data.replace(/[\t\n\r ]/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) throw uncertain('INVALID_IMAGE');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > LIMITS.outputImageBytes || data.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '') || !matchesSignature(data, mimeType)) throw uncertain('INVALID_IMAGE');
  return { data, mimeType };
}
function parseResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw uncertain('INVALID_RESPONSE');
  if (data.error) {
    const code = data.error.code;
    if (Number.isInteger(code) && code >= 400 && code <= 599) throw httpError(code);
    const status = data.error.status;
    if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') throw httpError(403);
    if (status === 'RESOURCE_EXHAUSTED') throw httpError(429);
    if (['INVALID_ARGUMENT', 'NOT_FOUND', 'FAILED_PRECONDITION', 'OUT_OF_RANGE'].includes(status)) throw httpError(400);
    throw uncertain('REMOTE_ERROR');
  }
  const feedback = data.promptFeedback ?? data.prompt_feedback;
  const blockReason = feedback?.blockReason ?? feedback?.block_reason;
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw providerError('PROVIDER_REJECTED', 'The image service blocked this prompt or its source images', 422, 'PROMPT_BLOCKED');
  if (!Array.isArray(data.candidates) || !data.candidates.length || data.candidates.length > 8) throw uncertain('INVALID_RESPONSE');
  const images = []; let bytes = 0; let blocked = false;
  for (const candidate of data.candidates) {
    if (!candidate || typeof candidate !== 'object') throw uncertain('INVALID_RESPONSE');
    const finish = candidate.finishReason ?? candidate.finish_reason;
    if (BLOCK_REASONS.has(finish)) { blocked = true; continue; }
    if (finish !== 'STOP') continue;
    const parts = candidate.content?.parts;
    if (!Array.isArray(parts) || parts.length > 128) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object' || part.thought === true) continue;
      const inline = part.inlineData ?? part.inline_data;
      if (inline === undefined) continue;
      if (images.length >= LIMITS.outputImages) throw uncertain('TOO_MANY_IMAGES');
      const image = parseInlineImage(inline); bytes += image.data.length;
      if (bytes > LIMITS.outputBytes) throw uncertain('OUTPUT_TOO_LARGE');
      images.push(image);
    }
  }
  if (images.length) return images;
  if (blocked) throw providerError('PROVIDER_REJECTED', 'The image service blocked the generated output', 422, 'OUTPUT_BLOCKED');
  throw uncertain('NO_IMAGE');
}
function publicRequestId(data, fallback, apiKey) {
  const value = data.responseId ?? data.response_id;
  const safe = candidate => typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) && !candidate.includes(apiKey);
  return safe(value) ? value : safe(fallback) ? fallback : undefined;
}

function createGeminiProvider({ env = process.env, fetchImpl = globalThis.fetch, config } = {}) {
  let resolved, preview, configError;
  try {
    preview = configuration(env, config, { allowMissingKey: true });
    resolved = configuration(env, config);
    invariant(typeof fetchImpl === 'function', 'PROVIDER_NOT_CONFIGURED', 'This runtime does not provide fetch', 503);
  } catch (error) {
    resolved = undefined;
    configError = error instanceof DomainError ? error : new DomainError('PROVIDER_NOT_CONFIGURED', 'The image provider configuration is invalid', 503);
  }
  return {
    describe({ model: requestedModel } = {}) {
      const defaultModel = preview?.model || DEFAULT_MODEL;
      let model = defaultModel;
      if (requestedModel !== undefined) {
        try { model = normalizeModel(requestedModel, preview?.apiKey); }
        catch (_) { throw new DomainError('INVALID_INPUT', 'The requested Gemini model name is invalid'); }
      }
      const description = name => {
        const profile = profileFor(name);
        return { settings: { temperature: { minimum: 0, maximum: 2 }, aspectRatio: ['auto', ...profile.aspectRatios], imageSize: [...profile.imageSizes] }, knownModel: profile.known, limits: { ...LIMITS, inputImages: profile.maxInputImages } };
      };
      return {
        id: 'gemini', configured: Boolean(resolved), model, defaultModel,
        capabilities: ['image.edit'], mask: 'advisory', automaticRetry: false,
        ...description(model),
        models: ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview'].map(id => ({ id, ...description(id) })),
        unknownModel: description('unverified-model'),
        ...(configError ? { configurationError: { code: 'PROVIDER_NOT_CONFIGURED', message: configError.message } } : {}),
      };
    },
    async generate(input, { signal } = {}) {
      if (signal !== undefined) invariant(signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function', 'INVALID_INPUT', 'signal must be an AbortSignal');
      if (signal?.aborted) throw cancelled();
      if (!resolved) throw configError;
      const request = buildRequest(input, resolved);
      const controller = new AbortController();
      let abortCause;
      const interrupt = cause => {
        if (!controller.signal.aborted) { abortCause = cause; controller.abort(); }
      };
      const onAbort = () => interrupt('cancelled');
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      const timer = setTimeout(() => interrupt('timeout'), resolved.timeoutMs);
      let response;
      try {
        if (controller.signal.aborted) throw cancelled();
        const fetchResult = fetchImpl(resolved.apiRoot + '/models/' + encodeURIComponent(request.model) + ':generateContent', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': resolved.apiKey }, body: request.body,
        });
        response = await abortable(Promise.resolve(fetchResult).then(value => {
          // A noncooperative injected fetch may resolve after the caller stopped waiting.
          response = value;
          if (controller.signal.aborted) cancelBody(value);
          return value;
        }), controller.signal);
        if (controller.signal.aborted) throw cancelled();
        if (!response || !Number.isInteger(response.status)) throw uncertain('INVALID_RESPONSE');
        if (response.status < 200 || response.status >= 300) { cancelBody(response); throw httpError(response.status); }
        const data = await readResponse(response, controller.signal);
        const images = parseResponse(data);
        if (controller.signal.aborted) throw cancelled();
        const requestId = publicRequestId(data, input.requestId, resolved.apiKey);
        return { images, provider: { id: 'gemini', model: request.model, ...(requestId ? { requestId } : {}) } };
      } catch (error) {
        if (controller.signal.aborted) {
          cancelBody(response);
          if (abortCause === 'timeout') throw uncertain('TIMEOUT', {}, 504);
          throw cancelled();
        }
        if (error instanceof DomainError && error[PROVIDER_ERROR]) throw error;
        throw uncertain('NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

module.exports = { createGeminiProvider, configuration };
