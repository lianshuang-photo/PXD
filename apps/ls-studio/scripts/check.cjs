'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|cjs)$/.test(entry.name)) { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); count++; }
  }
}
for (const dir of ['companion', 'plugin', 'scripts', 'tests']) check(path.join(root, dir));
const versions = ['package.json', 'companion/package.json', 'plugin/manifest.json'].map(file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version);
if (new Set(versions).size !== 1) throw new Error('App, Companion and UXP manifest versions must match');
const html = fs.readFileSync(path.join(root, 'plugin/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)) {
  if (!fs.existsSync(path.join(root, 'plugin', match[1]))) throw new Error('Missing panel asset: ' + match[1]);
}
console.log(`Checked ${count} JavaScript files, UXP assets and version ${versions[0]}`);
