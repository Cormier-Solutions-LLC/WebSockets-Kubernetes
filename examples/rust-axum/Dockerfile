ARG RUST_IMAGE=rust:1.98.1-alpine@sha256:1716b3aa042d735f4566d14dc54e8037de9d69556e2d5dd58131d93a613d173d
ARG ALPINE_IMAGE=alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
FROM ${RUST_IMAGE} AS build
WORKDIR /source
COPY examples/rust-axum/Cargo.toml examples/rust-axum/Cargo.lock ./
COPY examples/rust-axum/src ./src
RUN cargo build --locked --release

FROM ${ALPINE_IMAGE}
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=build /source/target/release/cormier-realtime-example-rust-axum ./application
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["/app/application"]
