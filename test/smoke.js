'use strict';

// HTTP smoke test against a running server.
//
//   BASE_URL set        -> tests that URL (used by the compose `verify` service)
//   BASE_URL unset      -> spawns src/server.js on an ephemeral port, waits
//                          for readiness, runs the scenarios, then tears it down
//
// Covers: health probe, happy-path replay with array moves, escaped JSON
// Pointer members (~0/~1), numeric-representation stability, pre/post hash
// mismatch rejection, pointer/test failures, atomic rollback semantics
// observed through hash chaining, body-size limit and malformed JSON.

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');

const { canonicalHash } = require('../src/jcs');
const { applyRevision } = require('../src/patch');
const { parseStrict } = require('../src/parse');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function request(baseURL, method, reqPath, bodyObj, rawOverride, headers = {}) {
  const url = new URL(reqPath, baseURL);
  const payload = rawOverride !== undefined
    ? rawOverride
    : (bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj)));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw.length ? JSON.parse(raw) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(baseURL, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await request(baseURL, 'GET', '/healthz');
      if (r.status === 200 && r.json && r.json.status === 'ok') return;
      lastErr = new Error(`status ${r.status}`);
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`server did not become healthy at ${baseURL}: ${lastErr}`);
}

async function startServer() {
  const port = 8000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForHealth(baseURL);
  return { child, baseURL };
}

function hashChain(baseline, revisionOps) {
  const revisions = [];
  let doc = baseline;
  for (const [revisionId, operations] of revisionOps) {
    const beforeHash = canonicalHash(doc);
    doc = applyRevision(doc, operations);
    revisions.push({ revisionId, beforeHash, afterHash: canonicalHash(doc), operations });
  }
  return { revisions, finalDoc: doc };
}

async function main() {
  let baseURL = process.env.BASE_URL;
  let child = null;
  if (!baseURL) {
    ({ child, baseURL } = await startServer());
    console.log(`spawned test server at ${baseURL}`);
  } else {
    console.log(`using server at ${baseURL}`);
    await waitForHealth(baseURL);
  }

  try {
    // 1. health
    {
      const r = await request(baseURL, 'GET', '/healthz');
      check('healthz returns 200 ok', r.status === 200 && r.json.status === 'ok', r.raw);
    }

    // 2. happy path: array moves + escaped pointer members + numeric stability
    let chain;
    {
      const baseline = parseStrict(JSON.stringify({
        line: 'L1',
        stations: [
          { id: 's0', pos: 0, params: { torque: 1.0, offset: 0.000001 } },
          { id: 's1', pos: 1, params: { torque: 2.5, offset: 1e-7 } },
          { id: 's2', pos: 2, params: { torque: 3, offset: 0 } },
        ],
        escaped: { 'a/b~c': 'marker' },
        big: 1e21,
      }));

      chain = hashChain(baseline, [
        ['rev-1-move', [
          // array shift: move last station to the front
          { op: 'move', from: '/stations/2', path: '/stations/0' },
          { op: 'test', path: '/stations/0/id', value: 's2' },
          // escaped pointer: member literally named a/b~c
          { op: 'test', path: '/escaped/a~1b~0c', value: 'marker' },
        ]],
        ['rev-2-add', [
          // add in the middle shifts later elements
          { op: 'add', path: '/stations/1', value: { id: 's9', pos: 9, params: { torque: 0, offset: 0 } } },
          { op: 'replace', path: '/escaped/a~1b~0c', value: 'moved' },
          // ~0 key containing a literal tilde
          { op: 'add', path: '/escaped/~0tilde', value: true },
        ]],
      ]);

      const r = await request(baseURL, 'POST', '/api/recipes/replay', { baseline, revisions: chain.revisions });
      check('replay happy path: 200', r.status === 200, `status=${r.status} body=${r.raw.slice(0, 400)}`);
      if (r.status === 200) {
        check('replay returns two revision digests',
          r.json.revisions.length === 2 &&
          r.json.revisions[0].revisionId === 'rev-1-move' &&
          r.json.revisions[1].revisionId === 'rev-2-add');
        check('array move observed (s2 at front, s9 inserted)',
          r.json.finalDocument.stations.map((s) => s.id).join(',') === 's2,s9,s0,s1',
          JSON.stringify(r.json.finalDocument.stations.map((s) => s.id)));
        check('escaped pointer replace/add observed',
          r.json.finalDocument.escaped['a/b~c'] === 'moved' &&
          r.json.finalDocument.escaped['~tilde'] === true,
          JSON.stringify(r.json.finalDocument.escaped));
        check('finalHash matches independently computed digest',
          r.json.finalHash === canonicalHash(chain.finalDoc),
          `${r.json.finalHash} != ${canonicalHash(chain.finalDoc)}`);
        check('numeric representation: 1e21 canonicalized deterministically',
          r.raw.includes('"big":1.0E+21'), r.raw.slice(0, 200));
        // determinism: byte-identical second response
        const r2 = await request(baseURL, 'POST', '/api/recipes/replay', { baseline, revisions: chain.revisions });
        check('replay is deterministic (byte-identical responses)', r2.raw === r.raw);
      }
    }

    // 3. before-hash mismatch: tampered snapshot, no continuation
    {
      const baseline = parseStrict('{"v":1}');
      const chain2 = hashChain(baseline, [
        ['r1', [{ op: 'replace', path: '/v', value: 2 }]],
        ['r2', [{ op: 'replace', path: '/v', value: 3 }]],
      ]);
      chain2.revisions[1].beforeHash = 'f'.repeat(64);
      const r = await request(baseURL, 'POST', '/api/recipes/replay', { baseline, revisions: chain2.revisions });
      check('tampered beforeHash -> 422 HASH_BEFORE_MISMATCH',
        r.status === 422 && r.json.error.code === 'HASH_BEFORE_MISMATCH',
        `${r.status} ${r.raw}`);
      check('error names revision 1',
        r.json.error.location && r.json.error.location.revisionIndex === 1 &&
        r.json.error.location.revisionId === 'r2',
        JSON.stringify(r.json.error.location));
    }

    // 4. after-hash mismatch
    {
      const baseline = parseStrict('{"v":1}');
      const chain2 = hashChain(baseline, [['r1', [{ op: 'replace', path: '/v', value: 2 }]]]);
      chain2.revisions[0].afterHash = '0'.repeat(64);
      const r = await request(baseURL, 'POST', '/api/recipes/replay', { baseline, revisions: chain2.revisions });
      check('wrong afterHash -> 422 HASH_AFTER_MISMATCH',
        r.status === 422 && r.json.error.code === 'HASH_AFTER_MISMATCH' &&
        r.json.error.location.revisionIndex === 0,
        `${r.status} ${r.raw}`);
    }

    // 5. failed test op with revision + operation position
    {
      const baseline = parseStrict('{"grip":{"force":10}}');
      const r = await request(baseURL, 'POST', '/api/recipes/replay', {
        baseline,
        revisions: [{
          // beforeHash must agree so the test failure is what surfaces
          // (afterHash is never reached); use the actual op that fails.
          revisionId: 'r-guard',
          beforeHash: canonicalHash(baseline),
          afterHash: '0'.repeat(64),
          operations: [{ op: 'test', path: '/grip/force', value: 99 }],
        }],
      });
      check('failing test op -> 422 TEST_FAILED with op index 0',
        r.status === 422 && r.json.error.code === 'TEST_FAILED' &&
        r.json.error.location.operationIndex === 0 &&
        r.json.error.location.revisionId === 'r-guard',
        `${r.status} ${r.raw}`);
    }

    // 6. failed atomicity: earlier ops in the revision must not persist — proven
    //    because the next revision's beforeHash (computed off the pre-revision
    //    doc) still matches once the failing op is removed.
    {
      const baseline = parseStrict('{"seq":[0,1,2],"flag":false}');
      const goodOps = [
        { op: 'add', path: '/seq/-', value: 3 },
        { op: 'replace', path: '/flag', value: true },
      ];
      const chain2 = hashChain(baseline, [
        ['atomic-ok', goodOps],
      ]);
      // Same chain but with a failing op appended to revision 0: must fail and
      // leave NO trace (server never mutates shared state anyway; verify via 422
      // and op index).
      const brokenRevision = {
        revisionId: 'atomic-ok',
        beforeHash: chain2.revisions[0].beforeHash,
        afterHash: chain2.revisions[0].afterHash,
        operations: [
          ...goodOps,
          { op: 'test', path: '/seq/9', value: 1 }, // nonexistent index
        ],
      };
      const r1 = await request(baseURL, 'POST', '/api/recipes/replay', {
        baseline,
        revisions: [brokenRevision],
      });
      check('op after applied ops fails -> 422 PATH_NOT_FOUND at op 2',
        r1.status === 422 && r1.json.error.code === 'PATH_NOT_FOUND' &&
        r1.json.error.location.operationIndex === 2,
        `${r1.status} ${r1.raw}`);
      // The exact good chain still replays cleanly right after => no cross-request leakage
      const r2 = await request(baseURL, 'POST', '/api/recipes/replay', {
        baseline,
        revisions: chain2.revisions,
      });
      check('clean chain replays 200 after failure (atomic + stateless)',
        r2.status === 200 && r2.json.finalDocument.flag === true &&
        JSON.stringify(r2.json.finalDocument.seq) === '[0,1,2,3]',
        `${r2.status} ${r2.raw.slice(0, 300)}`);
    }

    // 7. pointer escape / syntax errors
    {
      const baseline = parseStrict('{"x":1}');
      const chain2 = hashChain(baseline, [['r', [
        // build a valid afterHash so path syntax error surfaces mid-revision
      ]]]);
      const r = await request(baseURL, 'POST', '/api/recipes/replay', {
        baseline,
        revisions: [{
          revisionId: 'r', beforeHash: canonicalHash(baseline),
          afterHash: chain2.revisions[0].afterHash,
          operations: [{ op: 'add', path: 'bad~2escape', value: 1 }],
        }],
      });
      check('invalid ~2 escape -> 422 PATH_SYNTAX at op 0',
        r.status === 422 && r.json.error.code === 'PATH_SYNTAX' &&
        r.json.error.location.operationIndex === 0,
        `${r.status} ${r.raw}`);
    }

    // 8. malformed JSON and oversize / valid-oversize bodies
    {
      const r = await request(baseURL, 'POST', '/api/recipes/replay', undefined, Buffer.from('{oops,'));
      check('malformed JSON -> 400 REQ_MALFORMED',
        r.status === 400 && r.json.error.code === 'REQ_MALFORMED', `${r.status} ${r.raw}`);

      // A valid replay whose body is close to 2 MiB must still succeed.
      const pad = 'x'.repeat(2 * 1024 * 1024 - 1200);
      const bigBaseline = parseStrict(JSON.stringify({ pad, n: 1 }));
      const bigChain = hashChain(bigBaseline, [
        ['big-rev', [{ op: 'replace', path: '/n', value: 2 }]],
      ]);
      const rawValid = Buffer.from(JSON.stringify({ baseline: bigBaseline, revisions: bigChain.revisions }));
      check(`large valid body accepted (${rawValid.length} bytes < 2 MiB)`,
        rawValid.length <= 2 * 1024 * 1024);
      const r3 = await request(baseURL, 'POST', '/api/recipes/replay', undefined, rawValid);
      check('near-2 MiB valid replay -> 200',
        r3.status === 200 && r3.json.finalHash === canonicalHash(bigChain.finalDoc),
        `${r3.status} ${r3.raw.slice(0, 200)}`);

      const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0x61);
      const r2 = await request(baseURL, 'POST', '/api/recipes/replay', undefined, big);
      check('body over 2 MiB -> 413 REQ_TOO_LARGE',
        r2.status === 413 && r2.json.error.code === 'REQ_TOO_LARGE', `status=${r2.status}`);
    }

    // 9. unknown route
    {
      const r = await request(baseURL, 'GET', '/nope');
      check('unknown route -> 404 NOT_FOUND', r.status === 404 && r.json.error.code === 'NOT_FOUND', r.raw);
    }
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
  }

  if (failures > 0) {
    console.error(`\nSMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nSMOKE OK: all HTTP checks passed');
}

main().catch((err) => {
  console.error('smoke harness error:', err);
  process.exit(1);
});
