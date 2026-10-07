'use strict';

// HTTP API for recipe replay.
//   GET  /healthz            -> liveness probe, 200 {"status":"ok"}
//   POST /api/recipes/replay -> replay a baseline + ordered revisions

const http = require('node:http');
const { replay, ReplayError } = require('./replay');
const { canonicalString } = require('./jcs');

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB

function sendJSON(res, statusCode, payload) {
  // Responses use JCS canonical encoding too, so byte output is stable.
  const body = canonicalString(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJSON(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/recipes/replay') {
      const chunks = [];
      let size = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          // Stop retaining bytes; drain the rest of the upload so the
          // response can be delivered cleanly instead of racing a TCP reset.
          req.resume();
          sendJSON(res, 413, {
            error: {
              code: 'REQ_TOO_LARGE',
              message: `Request body exceeds the 2 MiB limit (received more than ${size} bytes)`,
            },
          });
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks, size);
        try {
          const result = replay(raw);
          sendJSON(res, 200, result);
        } catch (err) {
          if (err instanceof ReplayError) {
            sendJSON(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
                location: err.location,
              },
            });
            return;
          }
          sendJSON(res, 500, {
            error: { code: 'INTERNAL', message: 'Internal replay error' },
          });
        }
      });

      req.on('error', () => {
        if (!res.headersSent) {
          sendJSON(res, 400, { error: { code: 'REQ_READ_ERROR', message: 'Failed to read request body' } });
        }
      });
      return;
    }

    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${req.url} is not a known route` } });
  });
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    // Plain, single-line startup marker used by the smoke test readiness loop.
    console.log(`recipe-replay listening on ${host}:${port}`);
  });

  const shutdown = (signal) => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
    server.closeAllConnections?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, sendJSON };
