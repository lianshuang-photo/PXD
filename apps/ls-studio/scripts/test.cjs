'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const testDir = path.resolve(__dirname, '../tests');
const files = fs.readdirSync(testDir).filter(name => name.endsWith('.test.cjs')).sort().map(name => path.join(testDir, name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
