FROM ghcr.io/astral-sh/uv:0.12.13@sha256:b485bd65cc2cf1c9a93b3554012c9c3778cf7b1b5fd3d3096ce9e1226c97e1e6 AS uv
FROM python:3.14.7-alpine3.24@sha256:c6ead215bfd31f1e433d968853b7a769989117115b728874824e6c0a27cb96fc
RUN apk upgrade --no-cache
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY examples/python-fastapi/pyproject.toml examples/python-fastapi/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
    && rm -rf /usr/local/lib/python3.14/site-packages/pip* /usr/local/bin/pip*
COPY examples/python-fastapi/reference_app ./reference_app
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
ENV PATH=/app/.venv/bin:$PATH
USER 65532:65532
ENTRYPOINT ["python", "-m", "reference_app"]
