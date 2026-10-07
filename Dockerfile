FROM node:22-alpine

WORKDIR /app

# The service has zero third-party runtime dependencies; copy only what runs.
COPY package.json ./
COPY src ./src
COPY test ./test
COPY build.js ./build.js

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# Drop root; the app never needs it.
USER node

# Container-level liveness probe (Compose overrides/extends this too).
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
