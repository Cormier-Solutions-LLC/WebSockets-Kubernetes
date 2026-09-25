ARG NODE_IMAGE=node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
FROM ${NODE_IMAGE}

WORKDIR /app
COPY examples/node-express/package.json examples/node-express/package-lock.json ./
RUN apk upgrade --no-cache \
    && npm install --global npm@12.1.0 \
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
