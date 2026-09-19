'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.PXDLS_PORT ||= '17881';
process.env.PXDLS_HOST ||= '127.0.0.1';
process.env.PXDLS_AGENT_DATA ||= path.join(root, '.local', 'agent');
process.env.PXDLS_DATA_DIR ||= path.join(root, '.local', 'studio');
require('../companion/server.js');
