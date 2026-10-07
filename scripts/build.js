#!/usr/bin/env node
'use strict';

/**
 * Application build for a zero-runtime-dependency Node service.
 *
 * There is no transpilation step; "building" therefore means:
 *   1. syntax-check every module under src/ with node --check,
 *   2. require every non-main module to prove it loads cleanly,
 *   3. stage the application into dist/ with a build-info manifest
 *      containing SHA-256 over each staged file.
 * The dist/ artifact is what a runtime could ship; the container starts
 * directly from src/ which is content-identical to dist/src/.
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const files = walk(SRC);
  if (files.length === 0) throw new Error('no source files found');

  // 1. Syntax check.
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      process.stderr.write(`syntax check failed for ${file}\n${res.stderr}`);
      process.exit(1);
    }
  }

  // 2. Load check for library modules (server.js has a require.main guard).
  for (const file of files) {
    require(file);
  }

  // 3. Stage dist/.
  rimraf(DIST);
  copyDir(SRC, path.join(DIST, 'src'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(DIST, 'package.json'));

  const manifest = {
    name: 'recipe-replay',
    builtAt: new Date().toISOString(),
    node: process.version,
    files: walk(path.join(DIST)).map((f) => ({
      path: path.relative(DIST, f).split(path.sep).join('/'),
      sha256: sha256(f),
    })),
  };
  fs.writeFileSync(
    path.join(DIST, 'build-info.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  process.stdout.write(`build ok: ${manifest.files.length} files staged to dist/\n`);
}

main();
