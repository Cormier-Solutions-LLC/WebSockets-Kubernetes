FROM swift:6.3.3-noble@sha256:dd115b20969a2acf74c8dcf6da7c4aeda086053c27453dad59052a65bafc8d0c AS build
WORKDIR /source
COPY examples/swift-vapor/Package.swift examples/swift-vapor/Package.resolved ./
RUN --mount=type=cache,id=swift-vapor-build,target=/source/.build \
    swift package resolve --disable-sandbox
COPY examples/swift-vapor/Sources ./Sources
COPY examples/swift-vapor/Tests ./Tests
RUN --mount=type=cache,id=swift-vapor-build,target=/source/.build \
    swift build --configuration release --static-swift-stdlib --disable-sandbox \
    && cp "$(swift build --configuration release --show-bin-path)/CormierRealtimeVaporExample" /server

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
FROM swift:6.3.3-noble-slim@sha256:d20e340aeaf7109919b2a15c95569470070cca4d34dae40dfa58339a2aa734df
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini=0.19.0-1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
WORKDIR /app
COPY --from=build /server ./server
COPY examples/swift-vapor/Caddyfile /etc/caddy/Caddyfile
COPY examples/swift-vapor/start.sh ./start.sh
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
RUN mkdir -p /data/caddy /config/caddy \
    && chown -R 65532:65532 /app /data /config /tmp \
    && chmod 0555 /app/server /app/start.sh
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["/usr/bin/tini", "--", "/app/start.sh"]
