FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app
COPY examples/node-express/package.json examples/node-express/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY examples/node-express/src ./src
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk

ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER node
CMD ["node", "./src/server.mjs"]
