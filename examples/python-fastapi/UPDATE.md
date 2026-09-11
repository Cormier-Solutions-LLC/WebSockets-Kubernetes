# Update, deprecation, and rollback procedure

1. Inventory the locked Python, uv, FastAPI, Uvicorn, Redis client, HTTPX, WebSockets, Pydantic Settings, Redis service, Cormier.Realtime SDK/protocol/gateway, and canonical asset versions without recording configuration values.
2. Review official release notes, security advisories, support policies, deprecations, and Python/platform wheel availability. Validate the pinned runtime image architectures and uv prerequisite before changing the graph.
3. Preserve mutable deployment configuration and data outside the source tree. Back up Redis through the deployment runbook if record compatibility can change; never place credentials in build context or logs.
4. Update explicit requirements and image digests, run `uv lock --upgrade` (or targeted `--upgrade-package`), and review the complete `uv.lock` diff. Rebuild canonical TypeScript assets; never copy generated environments or shared assets into this source directory.
5. Run locked restore/check, Ruff, Pytest, pip-audit, image/non-root inspection, startup/health, shared browser smoke scenarios, expiry, rejected-Origin, gateway/Redis outage, redaction, second-run, and bounded clean-shutdown probes.
6. Deploy progressively and watch health, ticket/authentication failure, reconnect, Redis, and shutdown signals. Roll back image and configuration together on failure; restore Redis only through the approved recovery process.

For a release check from the previous supported example version, build both Git revisions with recorded pins, run the same external configuration and canonical browser suite against each image, update without changing Redis prefixes, then roll back and repeat login, ticket, connect, publish/receive, reconnect, logout, and health. The initial 0.1.0 example has no earlier in-repository version, so this two-revision check begins with its first update.

Announce every route, environment key, dependency/runtime line, asset/protocol version, or example deprecation in README and CHANGELOG before removal. Name its replacement, migration and verification steps, rollback, and approved removal release or support window; test old and replacement paths throughout that window. The current release has no deprecations.
