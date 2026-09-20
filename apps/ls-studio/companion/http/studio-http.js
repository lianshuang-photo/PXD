'use strict';

const { timingSafeEqual } = require('node:crypto');
const { DomainError, invariant, object, publicError } = require('../domain/contracts');
const { validateOperation } = require('../photoshop-tools');

const MAX_BODY_BYTES = 48 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 512 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
function localHost(host) { return ['localhost', '127.0.0.1', '[::1]'].includes(host); }
function localAddress(address) { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
function checkClient(req) {
  let host;
  try { host = new URL('http://' + req.headers.host); } catch (_) {}
  invariant(host && !host.username && !host.password && host.pathname === '/' && localHost(host.hostname), 'LOCAL_CLIENT_REQUIRED', 'Studio accepts only a loopback Host', 403);
  invariant(req.socket && localAddress(req.socket.remoteAddress), 'LOCAL_CLIENT_REQUIRED', 'Studio accepts only local clients', 403);
  const origin = req.headers.origin;
  if (origin === undefined) return;
  invariant(typeof origin === 'string', 'ORIGIN_REJECTED', 'Origin is invalid', 403);
  if (origin === 'null' || origin === 'file://') {
    // Native UXP has no browser fetch metadata. An opaque sandboxed web frame
    // must not use the native exception to gain access to local document state.
    invariant(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'ORIGIN_REJECTED', 'Opaque browser frames cannot access Studio', 403);
    return;
  }
  let url;
  try { url = new URL(origin); } catch (_) {}
  invariant(url && !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'uxp:' || (['http:', 'https:'].includes(url.protocol) && localHost(url.hostname) && url.pathname === '/')), 'ORIGIN_REJECTED', 'Only local Studio pages or native UXP may access this service', 403);
}
function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readJson(req) {
  invariant(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'JSON_REQUIRED', 'A JSON request is required', 415);
  invariant(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'UNSUPPORTED_ENCODING', 'Compressed request bodies are not accepted', 415);
  const length = req.headers['content-length'];
  invariant(length === undefined || (/^\d+$/.test(length) && Number(length) <= MAX_BODY_BYTES), 'BODY_TOO_LARGE', 'Request body exceeds 48 MiB', 413);
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], finished = false;
    const timer = setTimeout(() => finish(new DomainError('REQUEST_TIMEOUT', 'Request body timed out', 408)), 15000);
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', aborted); req.removeListener('error', failure);
      chunks = [];
      if (error) { req.once('error', () => {}); req.resume(); reject(error); } else resolve({ value, bytes });
    };
    const failure = () => finish(new DomainError('REQUEST_ABORTED', 'Request body was interrupted', 400));
    const aborted = failure;
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return finish(new DomainError('BODY_TOO_LARGE', 'Request body exceeds 48 MiB', 413));
      chunks.push(chunk);
    };
    const end = () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
      catch (_) { finish(new DomainError('INVALID_JSON', 'Request body is not valid JSON')); return; }
      finish(null, value);
    };
    req.on('data', data); req.on('end', end); req.on('error', failure); req.on('aborted', aborted);
  });
}
function checkedAsset(value) {
  invariant(value && value.asset && Buffer.isBuffer(value.data) && value.data.length > 0 && value.data.length <= MAX_ASSET_BYTES, 'ASSET_INTEGRITY', 'Managed image data is unavailable or exceeds its limit', 500);
  invariant(['image/png', 'image/jpeg', 'image/webp'].includes(value.asset.mimeType), 'ASSET_INTEGRITY', 'Managed image format is unsupported', 500);
  return value;
}
async function invoke(service, operation, args, source) {
  args = validateOperation(operation, args);
  if (['createDraft', 'updateDraft', 'run', 'loadRecipe'].includes(operation)) args = { ...args, source };
  if (operation === 'getDraft') return service.getDraft(args.draftId);
  if (operation === 'getRecipe') return service.getRecipe(args.recipeId);
  if (operation === 'getJob' || operation === 'cancel') return service[operation](args.jobId);
  if (operation === 'readAsset') {
    const { asset, data } = checkedAsset(await service.readAsset(args.assetId));
    return { asset, image: { base64: data.toString('base64'), mimeType: asset.mimeType, width: asset.width, height: asset.height } };
  }
  invariant(typeof service[operation] === 'function', 'CAPABILITY_UNAVAILABLE', 'This Studio operation is not currently available', 503);
  return service[operation](args);
}
function createStudioHttp({ service, toolToken } = {}) {
  invariant(service && typeof service === 'object', 'INVALID_INPUT', 'A shared capability service is required');
  async function handle(req, res, url) {
    if (url.pathname !== '/studio' && !url.pathname.startsWith('/studio/')) return false;
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, X-PXDLS-Agent, X-PXDLS-Tool',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    const json = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      const data = JSON.stringify(value);
      // Do not keep draining an oversized or stalled request indefinitely after
      // rejecting it; close its connection once the error response is written.
      res.writeHead(status, { ...headers, ...(status >= 400 && !req.complete ? { Connection: 'close' } : {}), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }); res.end(data);
    };
    try {
      checkClient(req);
      if (req.headers.origin) headers['Access-Control-Allow-Origin'] = req.headers.origin;
      const assetMatch = /^\/studio\/assets\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);
      const isCall = url.pathname === '/studio/call', isMcp = url.pathname === '/studio/mcp';
      invariant(assetMatch || isCall || isMcp, 'NOT_FOUND', 'Studio endpoint was not found', 404);
      if (req.method === 'OPTIONS') {
        invariant(['GET', 'POST'].includes(req.headers['access-control-request-method']) && (req.headers['access-control-request-headers'] || '').split(',').every(value => !value.trim() || ['content-type', 'x-pxdls-agent', 'x-pxdls-tool'].includes(value.trim().toLowerCase())), 'PREFLIGHT_REJECTED', 'Unsupported preflight request', 403);
        res.writeHead(204, headers); res.end(); return true;
      }
      invariant(req.headers['x-pxdls-agent'] === '1', 'CLIENT_MARKER_REQUIRED', 'Studio client marker is required', 403);
      if (assetMatch) {
        invariant(req.method === 'GET', 'METHOD_NOT_ALLOWED', 'Managed assets require GET', 405);
        const { asset, data } = checkedAsset(await service.readAsset(assetMatch[1]));
        if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { ...headers, 'Content-Type': asset.mimeType, 'Content-Length': data.length, 'Content-Disposition': 'inline' }); res.end(data); }
        return true;
      }
      invariant(req.method === 'POST', 'METHOD_NOT_ALLOWED', 'Studio calls require POST', 405);
      if (isMcp) invariant(tokenMatches(req.headers['x-pxdls-tool'], toolToken), 'TOOL_TOKEN_REQUIRED', 'Studio tool token is invalid', 403);
      const { value: body, bytes } = await readJson(req);
      object(body, 'request');
      invariant(Object.keys(body).every(key => ['operation', 'arguments'].includes(key)) && typeof body.operation === 'string' && Object.hasOwn(body, 'arguments'), 'INVALID_INPUT', 'Expected {operation, arguments}');
      invariant(body.operation === 'importAsset' || bytes <= MAX_ARGUMENT_BYTES, 'BODY_TOO_LARGE', 'Non-image operations are limited to 512 KiB', 413);
      const value = await invoke(service, body.operation, body.arguments, isMcp ? 'agent' : 'ui');
      json(200, { ok: true, value });
    } catch (error) {
      if (!req.complete) req.resume();
      json(error instanceof DomainError ? error.status : 500, { ok: false, error: publicError(error) });
    }
    return true;
  }
  return { handle };
}
module.exports = { createStudioHttp, invoke, MAX_BODY_BYTES, MAX_ARGUMENT_BYTES };
