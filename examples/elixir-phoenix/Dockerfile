ARG ELIXIR_IMAGE=hexpm/elixir:1.20.4-erlang-29.0.6-alpine-3.24.1@sha256:fec752d2a79fc50dc0a29b4da3c62f0a4925bc318f5391e5e221d01f98be6f22
FROM ${ELIXIR_IMAGE} AS build
ENV MIX_ENV=prod
WORKDIR /source
RUN mix local.hex --force && mix local.rebar --force
COPY examples/elixir-phoenix/mix.exs examples/elixir-phoenix/mix.lock ./
RUN mix deps.get --only prod --check-locked && mix deps.compile
COPY examples/elixir-phoenix/config ./config
COPY examples/elixir-phoenix/lib ./lib
RUN mix release

FROM ${ELIXIR_IMAGE}
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=build /source/_build/prod/rel/cormier_realtime_example ./release
COPY examples/shared-web/dist ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web/optimized
ENV SDK_ASSET_ROOT=/app/sdk
ENV ERL_CRASH_DUMP=/tmp/erl_crash.dump
USER 65532:65532
ENTRYPOINT ["/app/release/bin/cormier_realtime_example", "start"]
