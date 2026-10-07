'use strict';

const http = require('node:http');
const { parseStrict, JsonParseError } = require('./jsonparse');
const {
  replay,
  ReplayError,
  RequestValidationError,
} = require('./replay');
const { CanonicalizeError } = require('./jcs');

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleReplay(req, res) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body exceeds the 2 MiB limit',
          },
        });
        // Stop consuming further chunks; the 413 response is already flushed
        // without forcibly resetting the socket.
        return;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    // Client aborted or the connection was reset; nothing can be delivered.
    if (res.writableEnded || req.destroyed) return;
    res.destroy();
    return;
  }

  let body;
  try {
    body = parseStrict(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    if (err instanceof JsonParseError) {
      sendJson(res, 400, {
        error: {
          code: err.code,
          message: err.message,
        },
      });
      return;
    }
    throw err;
  }

  try {
    const result = replay(body);
    sendJson(res, 200, { status: 'ok', ...result });
  } catch (err) {
    if (err instanceof ReplayError) {
      sendJson(res, 422, {
        error: {
          code: err.code,
          message: err.message,
          revisionIndex: err.revisionIndex,
          revisionId: err.revisionId,
          operationIndex: err.operationIndex,
        },
      });
      return;
    }
    if (err instanceof RequestValidationError) {
      sendJson(res, 400, {
        error: {
          code: err.code,
          message: err.message,
        },
      });
      return;
    }
    if (err instanceof CanonicalizeError) {
      sendJson(res, 400, {
        error: {
          code: err.code,
          message: err.message,
        },
      });
      return;
    }
    if (err instanceof RangeError) {
      // Defensive: parser nesting caps should normally prevent this.
      sendJson(res, 400, {
        error: { code: 'NESTING_TOO_DEEP', message: 'Document nesting is too deep' },
      });
      return;
    }
    throw err;
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/recipes/replay') {
      handleReplay(req, res).catch((err) => {
        process.stderr.write(`Unhandled error: ${err.stack}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
        } else {
          res.destroy();
        }
      });
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid PORT: ${process.env.PORT}\n`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const actual = server.address().port;
    process.stdout.write(`recipe-replay service listening on 0.0.0.0:${actual}\n`);
  });

  const shutdown = (signal) => {
    process.stdout.write(`Received ${signal}, shutting down\n`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
