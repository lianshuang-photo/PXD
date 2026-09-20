'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
async function smoke(zipPath) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-package-'));
  let proc;
  try {
    const data = fs.readFileSync(zipPath); let pos = 0;
    while (data.readUInt32LE(pos) === 0x04034b50) {
      const size = data.readUInt32LE(pos + 18), length = data.readUInt16LE(pos + 26), extra = data.readUInt16LE(pos + 28);
      const name = data.subarray(pos + 30, pos + 30 + length).toString('utf8');
      assert.ok(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'));
      const start = pos + 30 + length + extra, target = path.join(temp, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, zlib.inflateRawSync(data.subarray(start, start + size))); pos = start + size;
    }
    const root = path.join(temp, fs.readdirSync(temp)[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'BUILD-MANIFEST.json'), 'utf8'));
    for (const file of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex'), file.sha256);
    let output = '';
    proc = spawn(process.execPath, [path.join(root, 'companion/server.js')], { env: { ...process.env, PXDLS_PORT: '0', PXDLS_AGENT_DATA: path.join(temp, 'agent'), PXDLS_DATA_DIR: path.join(temp, 'studio') }, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', data => { output += data.toString(); });
    let stderr = ''; proc.stderr.on('data', data => { stderr += data.toString(); });
    const deadline = Date.now() + 10000; let started;
    while (Date.now() < deadline && !started) {
      for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.event === 'companion.started') started = value; } catch (_) {} }
      if (!started) { if (proc.exitCode != null) throw new Error('Packaged service exited: ' + stderr); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(started && started.port > 0, 'packaged service must report its actual ephemeral port');
    const base = 'http://127.0.0.1:' + started.port;
    const health = await fetch(base + '/health').then(r => r.json()); assert.equal(health.ok, true);
    const ui = await fetch(base + '/ui/'); assert.equal(ui.status, 200); assert.match(await ui.text(), /LS|studio/i);
    console.log('Packaged runtime, source checksums and browser entrypoint verified');
  } finally {
    if (proc && proc.exitCode == null) { proc.kill(); await Promise.race([new Promise(resolve => proc.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) smoke(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { smoke };
