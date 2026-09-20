'use strict';

const { invariant } = require('../domain/contracts');
const localHost = name => ['localhost', '127.0.0.1', '[::1]'].includes(name);
const localAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
function parsed(value) { try { return typeof value === 'string' ? new URL(value) : null; } catch (_) { return null; } }
function localWeb(url) { return url && ['http:', 'https:'].includes(url.protocol) && localHost(url.hostname) && !url.username && !url.password; }

// Origin alone cannot identify a native client. Browser fetch metadata must be
// checked before CORS, preflight, attachment reads or host/session dispatch.
function checkClient(req) {
  const headers = req.headers || {}, rawHost = headers.host, host = parsed('http://' + rawHost);
  invariant(typeof rawHost === 'string' && !/[\s\\/@?#]/.test(rawHost) && host && localHost(host.hostname) && !host.username && !host.password && !host.search && !host.hash && host.pathname === '/', 'LOCAL_CLIENT_REQUIRED', 'Only a loopback Host is accepted', 403);
  invariant(req.socket && localAddress(req.socket.remoteAddress), 'LOCAL_CLIENT_REQUIRED', 'Only loopback clients are accepted', 403);
  const site = headers['sec-fetch-site'], origin = headers.origin;
  invariant(site === undefined || ['same-origin', 'same-site', 'cross-site', 'none'].includes(site), 'ORIGIN_REJECTED', 'Fetch metadata is invalid', 403);
  if (origin === undefined) {
    // Local browser image loads can omit Origin across localhost/127.0.0.1.
    // In that case require their browser-controlled, explicitly local referrer.
    invariant(site !== 'cross-site' || localWeb(parsed(headers.referer)), 'ORIGIN_REJECTED', 'Cross-site browser requests need an explicit local source', 403);
    return { native: site === undefined };
  }
  invariant(typeof origin === 'string', 'ORIGIN_REJECTED', 'Origin is invalid', 403);
  const url = parsed(origin), nativeOrigin = origin === 'null' || origin === 'file://' || url && url.protocol === 'uxp:' && url.hostname && !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/');
  if (nativeOrigin) {
    // UXP has no Sec-Fetch-Site. An opaque browser frame must not borrow this
    // exception, even when it claims same-origin or a user-initiated navigation.
    invariant(site === undefined, 'ORIGIN_REJECTED', 'Browser requests cannot use a native origin', 403);
    return { native: true };
  }
  invariant(localWeb(url) && !url.search && !url.hash && url.pathname === '/', 'ORIGIN_REJECTED', 'Only local pages or native UXP may access this service', 403);
  return { native: false };
}

function checkPreflight(req, allowedHeaders) {
  const method = req.headers['access-control-request-method'], requested = req.headers['access-control-request-headers'];
  invariant(['GET', 'POST'].includes(method) && (requested === undefined || typeof requested === 'string' && requested.split(',').every(value => !value.trim() || allowedHeaders.includes(value.trim().toLowerCase()))), 'PREFLIGHT_REJECTED', 'Unsupported preflight request', 403);
}

module.exports = { checkClient, checkPreflight };
