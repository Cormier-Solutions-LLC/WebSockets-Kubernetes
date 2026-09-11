ARG NODE_IMAGE=node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
FROM ${NODE_IMAGE}

WORKDIR /app
COPY examples/node-express/package.json examples/node-express/package-lock.json ./
RUN apk upgrade --no-cache \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY examples/node-express/src ./src
COPY examples/shared-web/dist ./shared-web
COPY sdk/typescript/dist ./sdk

ENV SHARED_ASSET_ROOT=/app/shared-web/optimized
ENV SDK_ASSET_ROOT=/app/sdk
USER node
CMD ["node", "./src/server.mjs"]
