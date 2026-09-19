const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const service = require('../scripts/companion-service.cjs');
const exec = promisify(execFile);

test('launchd owns the server after launcher exit, start is idempotent, and a killed process recovers', { skip: process.platform !== 'darwin' || process.env.PXDLS_SKIP_LAUNCHD_TEST === '1', timeout: 45000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-launchd-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const options = { root: path.join(temp, 'source & project'), home: path.join(temp, 'home'), label: 'com.pxdls.test.' + process.pid, port, codex: process.execPath };
  const config = service.configuration(options);
  t.after(async () => { await service.stop(config, true); fs.rmSync(temp, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(options.root, 'companion'), { recursive: true });
  fs.mkdirSync(path.join(options.root, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(options.root, 'companion/server.js'), `
    require('http').createServer((req,res) => res.end(JSON.stringify({ok:true,service:'com.pxdls.companion',pid:process.pid,ppid:process.ppid}))).listen(Number(process.env.PXDLS_PORT),'127.0.0.1');
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500));
  `);
  const launcher = path.join(temp, 'launcher.cjs');
  fs.writeFileSync(launcher, `const s=require(${JSON.stringify(require.resolve('../scripts/companion-service.cjs'))});s.start(s.configuration(${JSON.stringify(options)})).then(r=>console.log(r.pid)).catch(e=>{console.error(e);process.exitCode=1;});`);
  const first = await exec(process.execPath, [launcher], { timeout: 18000 });
  const pid = Number(first.stdout.trim());
  assert.ok(pid > 0);
  assert.equal((await service.health(config)).ppid, 1, 'launchd is the surviving parent');
  const second = await exec(process.execPath, [launcher], { timeout: 18000 });
  assert.equal(Number(second.stdout.trim()), pid, 'start does not spawn a duplicate');
  // Source removal must not break an installed service on its next restart.
  fs.renameSync(options.root, options.root + '.moved');
  process.kill(pid, 'SIGKILL');
  const deadline = Date.now() + 12000;
  let restored;
  while (Date.now() < deadline) {
    restored = await service.health(config);
    if (restored && restored.pid !== pid) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(restored && restored.pid !== pid, 'launchd restarts the installed runtime');
  assert.equal(restored.ppid, 1);
  await service.stop(config);
  assert.equal(service.loaded(config), null);
  fs.renameSync(options.root + '.moved', options.root);
  const restarted = await service.start(config);
  assert.notEqual(restarted.pid, restored.pid, 'restart waits for the departing launchd job');
});
