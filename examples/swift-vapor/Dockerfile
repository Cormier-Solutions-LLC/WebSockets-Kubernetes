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

FROM golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS caddy
WORKDIR /source
RUN go mod init caddy-build \
    && go get github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4 \
    && go get golang.org/x/crypto@v0.55.0 golang.org/x/net@v0.58.0 golang.org/x/text@v0.41.0 google.golang.org/grpc@v1.83.2 \
    && CGO_ENABLED=0 go build -o /out/caddy github.com/caddyserver/caddy/v2/cmd/caddy
FROM swift:6.3.3-noble-slim@sha256:d20e340aeaf7109919b2a15c95569470070cca4d34dae40dfa58339a2aa734df
RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends tini=0.19.0-1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=caddy /out/caddy /usr/local/bin/caddy
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
