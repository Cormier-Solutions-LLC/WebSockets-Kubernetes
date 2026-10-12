# syntax=docker/dockerfile:1
ARG RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4
FROM ${RUNNER_BASE} AS tools
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git jq unzip zip tar gzip procps libatomic1 libicu-dev libssl-dev \
    libunwind8 libgssapi-krb5-2 tzdata clang zlib1g-dev build-essential shellcheck \
    python3-yaml libncurses6 libsctp1 docker-buildx docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/*
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    DOTNET_INSTALL_DIR=/home/runner/.dotnet \
    DOTNET_ROOT=/home/runner/.dotnet \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup
RUN mkdir -p /opt/hostedtoolcache /opt/playwright-browsers /opt/playwright-tools /opt/ci-tools /home/runner/.dotnet \
    && chown -R runner:runner /opt/hostedtoolcache /opt/playwright-browsers /opt/playwright-tools /opt/ci-tools /home/runner/.dotnet
COPY vendor /tmp/setup-actions
COPY seed.py actions.lock.json /tmp/image-build/
RUN chown -R runner:runner /tmp/setup-actions && chmod +x /tmp/setup-actions/dotnet/externals/*.sh
USER runner
RUN python3 /tmp/image-build/seed.py node && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py dotnet && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py java && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py go && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py beam && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py python && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py rust && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py powershell && rm -rf /tmp/action-runtime
RUN python3 /tmp/image-build/seed.py browsers && rm -rf /tmp/action-runtime
COPY --chown=runner:runner wrappers /tmp/image-extras
COPY --chown=runner:runner extras.py /tmp/image-extras/extras.py
RUN python3 /tmp/image-extras/extras.py && rm -rf /tmp/image-extras

FROM tools
USER root
RUN rm -rf /tmp/setup-actions /tmp/image-build /tmp/action-runtime /home/runner/.npm/_cacache \
    && rm -rf /var/lib/apt/lists/* \
    && find /opt/hostedtoolcache /opt/playwright-browsers /opt/playwright-tools /opt/ci-tools /home/runner/.dotnet ! -user runner -exec chown runner:runner {} +
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    DOTNET_INSTALL_DIR=/home/runner/.dotnet \
    DOTNET_ROOT=/home/runner/.dotnet \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup \
    PATH=/opt/ci-tools/bin:/opt/hostedtoolcache/node/26.10.0/x64/bin:/home/runner/.dotnet:/home/runner/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LABEL org.opencontainers.image.title="Cormier Linux CI runner" \
      org.opencontainers.image.description="Ubuntu 24.04 ARC runner with audited CI toolchains and Playwright engines"
USER runner
