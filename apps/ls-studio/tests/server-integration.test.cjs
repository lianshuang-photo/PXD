'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function startCompanion(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-server-test-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../companion/server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PXDLS_HOST: '127.0.0.1', PXDLS_PORT: '0',
      PXDLS_AGENT_DATA: path.join(root, 'agent'),
      PXDLS_DATA_DIR: path.join(root, 'studio'),
      PXDLS_FACTORY_PRESETS: path.resolve(__dirname, '../companion/factory_presets'),
      // This test exercises local routing only. It cannot launch Codex or make a paid request.
      PXDLS_CODEX_BIN: path.join(root, 'disabled-codex'), PXDLS_GEMINI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let closed = false;
  const stopped = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  t.after(async () => {
    if (!closed) child.kill('SIGTERM');
    const force = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 3000);
    try { await stopped; } finally { clearTimeout(force); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  const port = await new Promise((resolve, reject) => {
    let pending = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('Isolated Companion did not start')), 10000);
    child.once('error', () => finish(new Error('Could not start isolated Companion')));
    child.once('exit', (code, signal) => finish(new Error('Isolated Companion exited before startup: ' + (signal || code))));
    child.stdout.on('data', chunk => {
      if (settled) return;
      pending += chunk.toString('utf8');
      if (pending.length > 65536) return finish(new Error('Unexpected startup output size'));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'companion.started' && Number.isInteger(event.port) && event.port > 0) finish(null, event.port);
      }
    });
  });
  return { child, port };
}

function malformedRequest(port) {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      // Send the actual invalid absolute-form target; a URL-aware HTTP client may reject it locally.
      socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('Malformed request did not finish')));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
  });
}

function jsonRequest(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method: payload ? 'POST' : 'GET', agent: false,
      headers: { 'X-PXDLS-Agent': '1', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, value: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local JSON request did not finish')));
    req.once('error', reject);
    req.end(payload);
  });
}

test('malformed request targets return 400 without terminating health or Studio dispatch', { timeout: 20000 }, async t => {
  const { child, port } = await startCompanion(t);
  const rejected = await malformedRequest(port);
  assert.match(rejected, /^HTTP\/1\.1 400 /);
  const health = await jsonRequest(port, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.value.ok, true);
  assert.equal(health.value.product, 'LS Studio V2');
  const studio = await jsonRequest(port, '/studio/call', { operation: 'discover', arguments: {} });
  assert.equal(studio.status, 200);
  assert.equal(studio.value.ok, true);
  assert.equal(studio.value.value.provider.configured, false);
  assert.equal(studio.value.value.photoshop.connected, false);
  assert.deepEqual(studio.value.value.capabilities.map(item => item.id), ['image.edit', 'ps.layer.update']);
  const settings = await jsonRequest(port, '/studio/provider-settings');
  assert.equal(settings.status, 200); assert.equal(settings.value.value.hasApiKey, false);
  assert.equal(settings.value.value.sources.apiKey, 'environment'); assert.equal(settings.value.value.configured, false);
  assert.equal(child.exitCode, null);
});
