'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const APP_ROOT = path.resolve(__dirname, '..');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(data) { let n = 0xffffffff; for (const b of data) n = table[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = entry.data, compressed = zlib.deflateRawSync(data, { level: 9 });
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function sourceFiles(root) {
  const result = [];
  const denied = /(?:^|\/)(?:node_modules|\.local|\.git|\.env(?:\..*)?|data|sessions|attachments|provider-config\.json)(?:\/|$)/;
  const explicit = new Set(['README.md', 'SOURCE-PROVENANCE.md', 'package.json', 'scripts/start-companion.sh', 'scripts/companion-service.cjs', 'scripts/dev.cjs']);
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--', '.'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const relative of [...new Set(tracked)].sort()) {
    if (!(relative.startsWith('plugin/') || relative.startsWith('companion/') || explicit.has(relative))) continue;
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('Package input must not be a symbolic link: ' + relative);
    if (denied.test(relative)) throw new Error('Runtime data is not a package input: ' + relative);
    if (!/\.(?:js|cjs|json|md|html|css|svg|png|jpg|jpeg|webp|woff|woff2|sh)$/.test(relative)) throw new Error('Unrecognized package input: ' + relative);
    if (stat.isFile()) result.push({ name: relative, data: fs.readFileSync(full), executable: relative.endsWith('.sh') });
  }
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function build({ root = APP_ROOT, outDir = path.join(APP_ROOT, 'dist'), commit, sourceDate } = {}) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (commit && commit !== head) throw new Error('Build commit must match the checked-out HEAD');
  commit = head;
  const commitDate = execFileSync('git', ['show', '-s', '--format=%cI', head], { cwd: root, encoding: 'utf8' }).trim();
  if (sourceDate && sourceDate !== commitDate) throw new Error('Build source date must match the checked-out commit');
  sourceDate = commitDate;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Build requires a full Git commit SHA');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = metadata.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a UXP-compatible three-part application version');
  for (const file of ['companion/package.json', 'plugin/manifest.json']) if (JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version !== version) throw new Error('Package version mismatch');
  const entries = sourceFiles(root);
  for (const entry of entries) {
    if (entry.name === 'package.json') {
      const app = JSON.parse(entry.data); app.scripts = { start: 'node companion/server.js', dev: 'node scripts/dev.cjs' };
      entry.data = Buffer.from(JSON.stringify(app, null, 2) + '\n');
    } else if (entry.name === 'companion/package.json') {
      const companion = JSON.parse(entry.data); companion.scripts = { start: 'node server.js' };
      entry.data = Buffer.from(JSON.stringify(companion, null, 2) + '\n');
    } else if (entry.name === 'README.md') {
      entry.data = Buffer.from(`# LS Studio ${version}\n\nExtract this ZIP and open a terminal in the extracted ls-studio-${version} folder. Install Node.js18+ separately, then run:\n\n\`\`\`sh\nnpm run dev\n\`\`\`\n\nOpen http://127.0.0.1:17881/ui/ for the browser preview. This launcher keeps local data in .local/ and leaves any installed Alpha service alone. For Photoshop, load plugin/manifest.json in UXP Developer Tool, then set the panel's Companion address to http://127.0.0.1:17881. Browser preview cannot execute Photoshop operations. Codex CLI and its login are separate prerequisites for Agent conversations.\n\nThis is an unpacked UXP source distribution, not a signed CCX installer. The Companion runs with Node on macOS/Windows/Linux; Photoshop host support still depends on the actual Photoshop/UXP environment. The launchd service scripts are macOS-specific and intentionally install/replace the selected runtime.\n\nProvider setup is described in companion/providers/README.md when present. No API keys are included. Verify SHA256SUMS from the release and BUILD-MANIFEST.json in this folder. See SOURCE-PROVENANCE.md for source attribution and licensing limits. Development tests/build scripts remain in the GitHub repository, not this runtime distribution.\n\nSource: https://github.com/lianshuang-photo/PXD/tree/${commit}/apps/ls-studio\n`, 'utf8');
    }
  }
  const sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.env.PXDLS_RELEASE_BUILD === '1' && sourceDirty) throw new Error('Release builds require a clean source checkout');
  const provenance = { schemaVersion: 1, product: 'LS Studio', version, commit, sourceDate, sourceDirty, runtime: { node: '>=18', photoshop: '>=24; production imaging requires host feature checks' }, files: entries.map(entry => ({ path: entry.name, sha256: sha256(entry.data), bytes: entry.data.length })) };
  entries.push({ name: 'BUILD-MANIFEST.json', data: Buffer.from(JSON.stringify(provenance, null, 2) + '\n') });
  const name = 'ls-studio-' + version;
  const outputs = [
    { name: name + '.zip', data: zip(entries.map(entry => ({ ...entry, name: name + '/' + entry.name }))) },
    { name: name + '-uxp-source.zip', data: zip(entries.filter(entry => entry.name.startsWith('plugin/')).map(entry => ({ ...entry, name: entry.name.slice(7) }))) },
    { name: name + '-manifest.json', data: Buffer.from(JSON.stringify(provenance, null, 2) + '\n') },
  ];
  const sbom = { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name, documentNamespace: 'https://github.com/lianshuang-photo/PXD/sbom/' + commit, creationInfo: { created: new Date(sourceDate).toISOString().replace('.000Z', 'Z'), creators: ['Tool: ls-studio-package'] }, packages: [{ name, SPDXID: 'SPDXRef-LSStudio', versionInfo: version, downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', comment: 'No npm runtime dependencies. Node.js, Photoshop and Codex are external prerequisites. See SOURCE-PROVENANCE.md for imported code, presets and fonts; ownership was not inferred.' }], relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-LSStudio' }] };
  outputs.push({ name: name + '-sbom.spdx.json', data: Buffer.from(JSON.stringify(sbom, null, 2) + '\n') });
  outputs.push({ name: 'SHA256SUMS', data: Buffer.from(outputs.map(file => sha256(file.data) + '  ' + file.name).join('\n') + '\n') });
  fs.mkdirSync(outDir, { recursive: true });
  for (const output of outputs) fs.writeFileSync(path.join(outDir, output.name), output.data);
  return { version, commit, outDir, files: outputs.map(output => output.name) };
}
if (require.main === module) console.log(JSON.stringify(build({ outDir: process.env.PXDLS_BUILD_DIR || undefined }), null, 2));
module.exports = { build, sourceFiles, zip, crc32 };
