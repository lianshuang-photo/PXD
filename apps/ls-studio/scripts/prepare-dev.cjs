'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.local/uxp');
// This directory is generated only; never overwrite the source or installed Alpha.
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(path.join(root, 'plugin'), target, { recursive: true, filter: source => !fs.lstatSync(source).isSymbolicLink() });
const manifestPath = path.join(target, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.id = 'com.pxdls.studio.v2.dev'; manifest.name = 'LS Studio V2 Dev';
manifest.entrypoints = manifest.entrypoints.map((entry, i) => ({ ...entry, id: 'pxdlsStudioV2Dev' + i, label: { default: 'LS Studio V2 Dev' } }));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'runtime-config.js'), 'window.PXD_RUNTIME = {companionBase:"http://127.0.0.1:17881",channel:"development"};\n');
const htmlPath = path.join(target, 'index.html');
fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace('</head>', '<script src="runtime-config.js"></script>\n</head>'));
fs.writeFileSync(path.join(target, 'DEV-SOURCE.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' }).trim() }, null, 2) + '\n');
console.log(manifestPath);
