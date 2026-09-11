ARG GO_IMAGE=golang:1.27.1-alpine@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125
ARG ALPINE_IMAGE=alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
FROM ${GO_IMAGE} AS build
WORKDIR /source
COPY examples/go-gin/go.mod examples/go-gin/go.sum ./
RUN go mod download
COPY examples/go-gin/*.go ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/application .

FROM ${ALPINE_IMAGE}
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=build /out/application ./application
COPY examples/shared-web/dist ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web/optimized
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["/app/application"]
