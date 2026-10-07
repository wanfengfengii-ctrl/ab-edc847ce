'use strict';

// Application "build" step: the service is plain Node.js with no compile
// stage, so the build verifies every source file parses cleanly and that
// all modules load. Used by the one-shot `verify` service.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const root = __dirname;
const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'test')),
  path.join(root, 'build.js'),
];

let failed = false;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`SYNTAX FAIL ${path.relative(root, file)}\n${r.stderr}`);
  } else {
    console.log(`syntax ok  ${path.relative(root, file)}`);
  }
}

// Module load check.
for (const mod of ['./src/jcs', './src/parse', './src/pointer', './src/patch', './src/replay', './src/server']) {
  require(mod);
  console.log(`load ok    ${mod}`);
}

if (failed) {
  console.error('build failed');
  process.exit(1);
}
console.log('build: OK');
