# Update, deprecation, and rollback procedure

This example supports updates only as an atomic repository change. Do not independently mix adapter, gateway, protocol, shared-web assets, or browser SDK revisions.

1. Inventory the current baseline before changing anything: `examples/python-fastapi/pyproject.toml`, `examples/python-fastapi/uv.lock`, `examples/python-fastapi/Dockerfile`, `examples/python-fastapi/.env.example`, `sdk/typescript/dist/version.json`, `protocol/fixtures/v1/envelopes.json`, and the gateway fixture used by `sdk/typescript/playwright.python-fastapi.config.mjs`.
2. Review Python/uv/FastAPI/Uvicorn/Redis client/HTTPX/WebSockets/Pydantic Settings, base-image, and Cormier.Realtime gateway/protocol release notes plus security advisories. Confirm Python `==3.14.*` support and wheel availability before changing pins.
3. Preserve mutable configuration and secrets outside source control. Keep all network identities and Redis prefixes environment-supplied, and never commit credentials, tokens, or rendered Secrets.
4. Update `pyproject.toml` and image digests together, then refresh the lock with `uv lock --upgrade` (or `uv lock --upgrade-package <name>`) and review the full `uv.lock` diff. Rebuild canonical browser assets from `sdk/typescript`; do not copy generated environments or shared assets into `examples/python-fastapi`.
5. Re-run the same validation gates used by CI:
   - `docker run --rm --volume "$PWD:/repo" --workdir /repo/examples/python-fastapi "$CI_PYTHON_IMAGE" sh -lc 'pip install --no-cache-dir uv==0.12.13 >/dev/null && uv sync --frozen && uv lock --check && uv run ruff check . && uv run ruff format --check . && uv run pytest && uv run pip-audit --local'`
   - `docker build --build-arg UV_IMAGE="$CI_UV_IMAGE" --build-arg PYTHON_IMAGE="$CI_PYTHON_IMAGE" --file examples/python-fastapi/Dockerfile --tag cormier-python-fastapi:<candidate> .`
   - `npx playwright test --config sdk/typescript/playwright.python-fastapi.config.mjs`
6. Expected results: lock check, lint, tests, and audit pass; container builds and runs as non-root user/group `65532:65532`; `/health` reports healthy with Redis reachable; browser smoke scenarios pass login/session/ticket/WebSocket/reconnect/logout plus expiry, rejected-Origin, and gateway-unavailable behavior.
7. Deploy progressively with immutable image + external configuration. If verification fails, roll back image and configuration together, re-run `/health` and browser smoke checks, and restore Redis only through the approved recovery runbook when data compatibility changed.

For a release check from the previous supported example version, build both revisions with recorded pins, run the same external configuration and the shared Playwright suite against each image, update without changing Redis prefixes, then roll back and repeat login, ticket, connect, publish/receive, reconnect, logout, and health verification.

Do not silently remove routes, environment keys, runtime/dependency ranges, shared assets, protocol compatibility, or this example. Announce deprecations in `README.md` and `CHANGELOG.md` first, including replacement, migration and verification steps, rollback, and removal release/support window. If cross-document drift is found while updating this file, track follow-up in the sibling docs sub-issue. The current release has no active deprecations.
