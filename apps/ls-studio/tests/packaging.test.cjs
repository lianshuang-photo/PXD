const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceFiles, zip, build } = require('../scripts/package.cjs');
test('packager excludes ignored logs, temp files and untracked data even in a clean source tree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-package-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  fs.mkdirSync(path.join(root, 'plugin')); fs.mkdirSync(path.join(root, 'companion'));
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n*.tmp\n');
  fs.writeFileSync(path.join(root, 'plugin/index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'companion/server.js'), 'module.exports = {};');
  execFileSync('git', ['add', '.'], { cwd: root });
  fs.writeFileSync(path.join(root, 'companion/private.log'), 'private fixture');
  fs.writeFileSync(path.join(root, 'plugin/session.tmp'), 'private fixture');
  fs.writeFileSync(path.join(root, 'companion/untracked.json'), '{"private":true}');
  assert.deepEqual(sourceFiles(root).map(file => file.name), ['companion/server.js', 'plugin/index.html']);
});
test('ZIP bytes are deterministic for the same named inputs', () => {
  const entries = [{name:'plugin/index.html',data:Buffer.from('fixture')},{name:'start.sh',data:Buffer.from('node companion/server.js'),executable:true}];
  assert.deepEqual(zip(entries), zip(entries));
});
test('full tracked application inventory is packagable with required runtime assets', () => {
  const files = sourceFiles(path.resolve(__dirname, '..'));
  for (const name of ['plugin/index.html', 'companion/server.js', 'companion/mock-vendor.jpg', 'companion/factory_presets/f_000.json']) {
    assert.ok(files.some(file => file.name === name && file.data.length), 'Missing runtime input: ' + name);
  }
});
test('builder cannot label current checkout bytes with another commit or timestamp', () => {
  const root = path.resolve(__dirname, '..');
  assert.throws(() => build({ root, commit: '0'.repeat(40) }), /checked-out HEAD/);
  assert.throws(() => build({ root, sourceDate: '1980-01-01T00:00:00Z' }), /checked-out commit/);
});
