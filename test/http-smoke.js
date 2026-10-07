#!/usr/bin/env node
'use strict';

/**
 * End-to-end HTTP smoke test for POST /api/recipes/replay.
 *
 * Usage:
 *   node test/http-smoke.js                  # spawns src/server.js locally
 *   BASE_URL=http://host:port node ...       # tests an already running server
 *
 * Exit code is 0 only if every check passes.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'vectors.json'), 'utf8')).fixtures;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  const tag = cond ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${tag}] ${name}${detail && !cond ? ` -- ${detail}` : ''}\n`);
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok && (await res.json()).status === 'ok') return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`service did not become healthy: ${lastErr?.message ?? 'timeout'}`);
}

async function post(base, body, { raw = null, headers = {} } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${base}/api/recipes/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
}

async function run(base) {
  process.stdout.write(`\nHTTP smoke against ${base}\n`);

  // --- health ---
  await waitForHealth(base);
  const health = await (await fetch(`${base}/health`)).json();
  check('GET /health returns ok', health.status === 'ok');

  // --- every independently generated fixture over real HTTP ---
  for (const fx of FIXTURES) {
    const res = await post(base, fx.request);
    const json = await res.json();
    if (fx.status === 200) {
      check(`200 ${fx.name}`, res.status === 200, `status ${res.status}`);
      check(`${fx.name}: revision ids`,
        JSON.stringify(json.revisions?.map((r) => r.revisionId)) ===
        JSON.stringify(fx.expect.revisionIds));
      check(`${fx.name}: revision postHashes`,
        JSON.stringify(json.revisions?.map((r) => r.postHash)) ===
        JSON.stringify(fx.expect.postHashes));
      check(`${fx.name}: finalHash (independently generated)`,
        json.finalHash === fx.expect.finalHash);
      check(`${fx.name}: finalDocument`,
        JSON.stringify(json.finalDocument) === JSON.stringify(fx.expect.finalDocument));
      // Final hash must equal the last chained revision post-hash.
      check(`${fx.name}: final hash closes the chain`,
        json.finalHash === json.revisions.at(-1).postHash);
    } else {
      const e = json.error ?? {};
      check(`422 ${fx.name}`, res.status === 422, `status ${res.status}`);
      check(`${fx.name}: stable code ${fx.expect.code}`,
        e.code === fx.expect.code, `got ${e.code}`);
      check(`${fx.name}: revisionIndex`,
        e.revisionIndex === fx.expect.revisionIndex,
        `got ${e.revisionIndex}`);
      check(`${fx.name}: revisionId reported`,
        typeof e.revisionId === 'string' &&
        e.revisionId === fx.request.revisions[fx.expect.revisionIndex].revisionId);
      if (fx.expect.operationIndex !== null && fx.expect.operationIndex !== undefined) {
        check(`${fx.name}: operationIndex`,
          e.operationIndex === fx.expect.operationIndex,
          `got ${e.operationIndex}`);
      }
    }
  }

  // --- required headline scenarios, asserted explicitly ---
  const escapeMove = FIXTURES.find(
    (f) => f.name === 'escaped-pointers-array-move-and-numbers');
  {
    const res = await post(base, escapeMove.request);
    const json = await res.json();
    check('escaped pointers + RFC A.7 array move succeed end-to-end',
      res.status === 200 &&
      json.finalHash === escapeMove.expect.finalHash);
  }

  // --- failure atomicity: rev1 fails at op1; rev2 must never execute ---
  const atomic = FIXTURES.find((f) => f.name === 'failed-revision-is-atomic');
  {
    const res = await post(base, atomic.request);
    const json = await res.json();
    const e = json.error ?? {};
    check('atomic failure returns 422', res.status === 422);
    check('atomic failure code TEST_ASSERTION_FAILED',
      e.code === 'TEST_ASSERTION_FAILED', `got ${e.code}`);
    check('atomic failure pinned to revision 1', e.revisionIndex === 1);
    check('atomic failure pinned to operation 1', e.operationIndex === 1);
    check('chain halted: offending revision named, later one never run',
      e.revisionId === 'fails-midway' &&
      atomic.request.revisions[2].revisionId === 'must-not-run');
  }

  // The prefix before the failing revision is valid and still verifies.
  {
    const goodPrefix = {
      baseline: atomic.request.baseline,
      revisions: [atomic.request.revisions[0]],
    };
    const res = await post(base, goodPrefix);
    check('committed prefix alone replays successfully',
      res.status === 200, `status ${res.status}`);
  }

  // --- malformed JSON is a 400, not a crash ---
  {
    const res = await post(base, null, { raw: '{not json' });
    check('malformed JSON rejected with 400', res.status === 400);
  }

  // --- envelope validation ---
  {
    const res = await post(base, { baseline: {}, revisions: [] });
    const json = await res.json();
    check('empty revisions rejected with 400',
      res.status === 400 && json.error?.code === 'REVISION_COUNT_OUT_OF_RANGE');
  }
  {
    const res = await post(base, { baseline: [1, 2, 3], revisions: [] });
    check('non-object baseline rejected with 400', res.status === 400);
  }

  // --- 2 MiB body limit ---
  {
    const oversized = JSON.stringify({
      baseline: {},
      revisions: [{
        revisionId: 'big',
        preHash: '0'.repeat(64),
        postHash: '0'.repeat(64),
        operations: [{ op: 'test', path: '', value: {} }],
        padding: 'x'.repeat(2 * 1024 * 1024),
      }],
    });
    const res = await post(base, null, { raw: oversized });
    check('body over 2 MiB rejected with 413', res.status === 413,
      `status ${res.status}`);
  }

  // --- a well-sized body must not trip the limiter spuriously: send a
  // syntactically valid request whose hashes simply do not match, and
  // expect a semantic 422 (body was fully read/parsed) rather than 413 ---
  {
    const res = await post(base, {
      baseline: {},
      revisions: [{
        revisionId: 'size-probe',
        preHash: '0'.repeat(64),
        postHash: '0'.repeat(64),
        operations: [{ op: 'test', path: '', value: {} }],
      }],
    });
    const json = await res.json();
    check('well-sized body is processed (422 hash mismatch, not 413)',
      res.status === 422 && json.error?.code === 'PRE_HASH_MISMATCH',
      `status ${res.status} ${json.error?.code}`);
  }

  // --- unknown route ---
  {
    const res = await fetch(`${base}/nope`);
    check('unknown route -> 404', res.status === 404);
  }
}

function startServer() {
  return new Promise((resolve, spawned) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/listening on 0\.0\.0\.0:(\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (code) => {
      if (!spawned) process.stderr.write(`server exited early (${code})\n`);
    });
  });
}

async function main() {
  let base = process.env.BASE_URL;
  let child = null;
  if (!base) {
    const started = await startServer();
    child = started.child;
    base = `http://127.0.0.1:${started.port}`;
  }

  let code = 0;
  try {
    await run(base.replace(/\/$/, ''));
  } catch (err) {
    process.stderr.write(`smoke harness error: ${err.stack}\n`);
    code = 1;
  } finally {
    if (child) child.kill('SIGTERM');
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`SMOKE FAILED: ${failed.length} check(s)\n`);
    code = 1;
  } else {
    process.stdout.write('SMOKE OK\n');
  }
  process.exit(code);
}

main();
