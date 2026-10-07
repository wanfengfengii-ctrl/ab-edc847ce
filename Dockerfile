# Zero-runtime-dependency Node.js service.
FROM node:22-alpine

WORKDIR /app

# Application and test sources (fixtures are committed under test/fixtures).
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

# No `npm install` step is required: the service uses only Node built-ins.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=20 \
  CMD node scripts/healthcheck.js

CMD ["node", "src/server.js"]
