# Update, deprecation, and rollback procedure

1. Inventory the locked Ruby, Bundler, Rails, Puma, Redis client, JSON, Caddy, Redis service, Cormier.Realtime SDK/protocol/gateway, and canonical asset versions without recording configuration values.
2. Review official release notes, security advisories, support policies, deprecations, Ruby/platform extension availability, and Rails compatibility before changing the graph. In particular, verify Rails request parsing before adopting a new major `json` gem line.
3. Preserve mutable deployment configuration and data outside the source tree. Back up Redis through the deployment runbook if record compatibility can change; never place credentials in build context or logs.
4. Update explicit gems and image digests, run a targeted `bundle _4.0.20_ update`, and review the complete `Gemfile.lock` diff. Rebuild canonical TypeScript assets; never copy vendored gems or shared assets into this source directory.
5. Run locked bundle check, RuboCop, Minitest, Brakeman, bundler-audit, image/non-root inspection, startup/health, shared browser smoke scenarios, expiry, rejected-Origin, gateway/Redis outage, redaction, second-run, and clean-shutdown probes.
6. Deploy progressively and watch health, ticket/authentication failure, reconnect, Redis, and shutdown signals. Roll back image and configuration together on failure; restore Redis only through the approved recovery process.

For a release check from the previous supported example version, build both Git revisions with recorded pins, run the same external configuration and canonical browser suite against each image, update without changing Redis prefixes, then roll back and repeat login, ticket, connect, publish/receive, reconnect, logout, and health. The initial 0.1.0 example has no earlier in-repository version, so this two-revision check begins with its first update.

Announce every route, environment key, dependency/runtime line, asset/protocol version, or example deprecation in README and CHANGELOG before removal. Name its replacement, migration and verification steps, rollback, and approved removal release or support window; test old and replacement paths throughout that window. The current release has no deprecations.
