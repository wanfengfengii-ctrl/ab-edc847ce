#!/usr/bin/env node
'use strict';

/**
 * Container health check: hits the local /health endpoint and exits non-zero
 * on any failure. Used both by the Dockerfile HEALTHCHECK and Compose.
 */
(async () => {
  const port = process.env.PORT || 8080;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) {
      process.exit(0);
    }
    process.stderr.write(`health check failed: HTTP ${res.status}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`health check failed: ${err.message}\n`);
    process.exit(1);
  }
})();
