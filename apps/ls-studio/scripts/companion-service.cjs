#!/usr/bin/env node
'use strict';

// A per-user launchd job owns the process, rather than the terminal that started it.
// Only runtime paths are installed; authentication remains in Codex's own store.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const LABEL = 'com.pxdls.companion';

function executable(name, searchPath = process.env.PATH || '') {
  const candidates = name.includes('/') ? [path.resolve(name)] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  throw new Error('找不到可执行文件：' + name);
}

function configuration(options = {}) {
  const home = options.home || os.homedir();
  const root = options.root || path.resolve(__dirname, '..');
  const label = options.label || LABEL;
  const port = Number(options.port || process.env.PXDLS_PORT || 17880);
  const host = options.host || process.env.PXDLS_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PXDLS_PORT 必须是有效端口');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Companion 后台服务只允许监听本机回环地址');
  const logs = path.join(home, '.pxdls/logs');
  const runtime = path.join(home, '.pxdls/service/runtime');
  return {
    root, runtime, home, label, host, port,
    domain: 'gui/' + process.getuid(), target: 'gui/' + process.getuid() + '/' + label,
    plistPath: path.join(home, 'Library/LaunchAgents', label + '.plist'),
    logPath: path.join(logs, 'companion.log'), errorPath: path.join(logs, 'companion.error.log'),
    node: options.node || process.execPath,
    // Resolve on installation; launchd does not run the user's interactive shell.
    codex: options.codex || executable(process.env.PXDLS_CODEX_BIN || 'codex'),
    data: options.data || process.env.PXDLS_AGENT_DATA || path.join(home, '.pxdls/agent'),
    factory: options.factory || process.env.PXDLS_FACTORY_PRESETS || path.join(runtime, 'companion/factory_presets'),
  };
}

function xml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
function plist(config) {
  const env = {
    HOME: config.home,
    PATH: [...new Set([path.dirname(config.node), path.dirname(config.codex), path.join(config.home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
    PXDLS_HOST: config.host, PXDLS_PORT: config.port, PXDLS_CODEX_BIN: config.codex,
    PXDLS_AGENT_DATA: path.resolve(config.data), PXDLS_FACTORY_PRESETS: path.resolve(config.factory),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(config.label)}</string>
<key>ProgramArguments</key><array><string>${xml(config.node)}</string><string>${xml(path.join(config.runtime, 'companion/server.js'))}</string></array>
<key>WorkingDirectory</key><string>${xml(config.runtime)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>3</integer>
<key>ExitTimeOut</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(config.logPath)}</string>
<key>StandardErrorPath</key><string>${xml(config.errorPath)}</string>
</dict></plist>
`;
}

function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
}
function loaded(config) { try { return launchctl('print', config.target); } catch (_) { return null; } }
function health(config, route = '/health') {
  return new Promise(resolve => {
    const req = http.get({ hostname: config.host, port: config.port, path: route, headers: { 'X-PXDLS-Agent': '1' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.setTimeout(1200, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
async function ready(config) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const job = loaded(config), result = await health(config);
    const pid = job && Number((job.match(/\bpid = (\d+)/) || [])[1]);
    if (result && result.service === LABEL && result.pid === pid) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Companion 尚未就绪，请查看日志：' + config.errorPath);
}

async function start(config) {
  const desired = plist(config);
  if (loaded(config)) {
    if (!fs.existsSync(config.plistPath) || fs.readFileSync(config.plistPath, 'utf8') !== desired) {
      throw new Error('已有后台服务配置不同。请用 restart 更新；不会自动中断当前对话。');
    }
    return ready(config);
  }
  if (await health(config)) throw new Error('端口 ' + config.port + ' 已有服务运行，请先停止该实例再启用后台服务。');
  // Install app files outside Downloads. A background process must not depend on
  // a terminal's access to a protected/downloaded development directory.
  const staging = config.runtime + '.staging-' + process.pid;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const folder of ['companion', 'plugin']) fs.cpSync(path.join(config.root, folder), path.join(staging, folder), { recursive: true });
    fs.writeFileSync(path.join(staging, 'source.json'), JSON.stringify({ root: config.root, installedAt: new Date().toISOString() }));
    fs.rmSync(config.runtime, { recursive: true, force: true });
    fs.renameSync(staging, config.runtime);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.logPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.plistPath + '.tmp', desired, { mode: 0o600 });
  fs.renameSync(config.plistPath + '.tmp', config.plistPath);
  launchctl('enable', config.target);
  launchctl('bootstrap', config.domain, config.plistPath);
  return ready(config);
}

async function stop(config, force = false) {
  if (!loaded(config)) return;
  if (!force) {
    const result = await health(config, '/agent/session');
    if (result && result.session && ['starting', 'running', 'waiting', 'stopping'].includes(result.session.status)) {
      throw new Error('Codex 正在执行。请先在面板停止；确需中断可加 --force。');
    }
  }
  launchctl('bootout', config.target);
  // bootout can return while the old job is still finishing long-poll requests.
  // Do not mistake that departing job for an already-started replacement.
  const deadline = Date.now() + 10000;
  while (loaded(config)) {
    if (Date.now() >= deadline) throw new Error('旧 Companion 尚未退出，请稍后重试。');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('后台服务使用 macOS launchd；其他平台请运行 start-companion.sh foreground。');
  const command = process.argv[2] || 'start';
  if (!['start', 'status', 'stop', 'restart', 'uninstall'].includes(command)) throw new Error('用法：start-companion.sh [start|status|stop|restart|uninstall|foreground] [--force]');
  const config = configuration();
  if (command === 'status') {
    const result = await health(config);
    console.log(JSON.stringify({ managed: !!loaded(config), healthy: !!(result && result.service === LABEL), pid: result && result.pid, agent: result && result.agent, log: config.logPath, errors: config.errorPath }, null, 2));
    return;
  }
  if (['stop', 'restart', 'uninstall'].includes(command)) await stop(config, process.argv.includes('--force'));
  if (command === 'uninstall') {
    // Only uninstall this job. Conversation data and logs are retained.
    fs.rmSync(config.plistPath, { force: true });
    console.log('已移除 Companion 登录启动项；对话与日志保留。');
  } else if (command === 'stop') console.log('Companion 已停止；下次登录仍会启动。长期停用请用 uninstall。');
  else {
    const result = await start(config);
    console.log('LS Studio 已就绪：http://' + (config.host === '::1' ? '[::1]' : config.host) + ':' + config.port + '/ui/');
    console.log('macOS 后台服务 PID ' + result.pid + '；可关闭当前终端。日志：' + config.logPath);
  }
}

module.exports = { configuration, plist, start, stop, health, loaded, ready };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
