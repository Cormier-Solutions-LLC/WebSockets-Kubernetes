# Optimized reference assets

The ten reference web stacks consume one generated asset set from `examples/shared-web/dist`. The TypeScript SDK build creates that set from the canonical files in `examples/shared-web/wwwroot`; adapters must not maintain stack-specific HTML, CSS, or JavaScript copies.

## Profiles

| Use | Directory | JavaScript | Source maps |
| --- | --- | --- | --- |
| Development and support | `dist/readable` | Readable application and SDK IIFE | SDK maps remain available |
| Production | `dist/optimized` | Minified application and SDK IIFE | Stored under `dist/source-maps/optimized`, outside the served root |
| Explicit hardening experiment | `dist/obfuscated` | Deterministically minified and obfuscated application JavaScript | Stored under `dist/source-maps/obfuscated`, outside the served root |

Production containers set `SHARED_ASSET_ROOT` to `/app/shared-web/optimized`. Local non-Release .NET development continues to use the canonical readable source. The asset root remains configuration so an operator can select the readable profile for diagnosis or rollback without changing application code.

Obfuscation is disabled by default. It is not a security boundary, does not protect browser-delivered secrets, and can make debugging and accessibility investigation harder. Enable it only through the explicit build command after evaluating those tradeoffs:

```console
cd sdk/typescript
npm ci
npm run build:obfuscated
```

## Determinism and metadata

`npm run build` produces readable and optimized profiles. `npm run check` builds the default output twice, builds the optional obfuscated output twice, compares SHA-256 inventories, restores the default output, and validates it. Tool versions are exact dependencies in `package-lock.json`.

`asset-manifest.json` records the pipeline version, profile defaults, tool versions, selector mappings, source-map policy, byte counts, deterministic gzip counts, SHA-256 hashes, and SHA-384 Subresource Integrity values. `size-report.json` enforces the optimized aggregate byte and gzip budgets. Legal notices are retained in HTML, CSS, and JavaScript.

The generated HTML uses external scripts and styles compatible with the reference Content Security Policy. It includes SRI for application CSS, application JavaScript, and the matching SDK IIFE. The shared browser suite loads the optimized profile in every adapter and verifies CSP, SRI-bearing references, accessible controls, live-region semantics, and the existing login/reconnect/publish lifecycle.

## Selector coordination

Selector mangling is disabled by default in `sdk/typescript/asset-pipeline.config.json`. If enabled, every mapping is explicit and the pipeline rewrites CSS, HTML, and JavaScript as one unit. Automation and accessibility hooks in the safelist cannot be mapped. Never remove an identifier from the safelist until browser, accessibility, and integration consumers have migrated together.

## Source maps and support

Optimized source maps use source-relative names and are checked for source-machine paths. They are retained under the sibling `dist/source-maps` tree for authorized debugging and artifact correlation, outside each configured profile root; reference adapters expose only `index.html`, `app.css`, and `app.js`. Treat maps as release artifacts from the same build and do not mix them across versions.

For a production-only failure, reproduce against `dist/readable` with the same SDK and gateway versions. Compare the manifest hashes and browser console before changing minifier options. Do not publish source maps merely to diagnose a public deployment; retrieve the matching build artifact through the authorized release channel.

## Update, migration, and rollback

Update one pinned optimization dependency at a time, run `npm run check`, then run the full adapter browser matrix. Review output size, CSP/SRI behavior, selector mappings, accessibility, and readable/optimized behavior parity. A pipeline, profile, or mapping contract change requires a `pipelineVersion` update and migration notes.

Pipeline 1.1.0 moves optimized and obfuscated application source maps from their served profile directories to `dist/source-maps/<profile>`. Artifact consumers upgrading from 1.0.0 must read map paths from `asset-manifest.json` instead of assuming that maps sit beside the generated CSS and JavaScript. Deployments should continue serving only the selected profile directory; support tooling may retain the sibling source-map tree in an access-controlled build artifact.

To roll back an asset regression, deploy the prior immutable asset set or point `SHARED_ASSET_ROOT` at the matching readable profile. Roll back the SDK and reference assets together because SRI values bind each page to exact bytes. Disable optional obfuscation by returning to `npm run build`; it is never required for compatibility.
