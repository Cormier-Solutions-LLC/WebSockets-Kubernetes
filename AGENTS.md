# Repository agent guidance

## Product identity

- Use `Cormier` for the distributable brand and `Cormier.Realtime` for .NET solution, project, namespace, assembly, and package identities.
- Treat customer, tenant, environment, and deployment suffixes as configuration. Never encode a customer-specific or legacy brand in source-controlled identifiers.
- Use the bootstrap `-NameSuffix` option to derive a consistent deployable instance name. Consume `.bootstrap/naming.json` where automation needs those derived names; the generated file is local and must not be committed.

## Environment-specific configuration

- Every domain, origin, host/server name, IP address, CIDR, port, external endpoint, Kubernetes context, namespace, release name, image registry/repository, and Secret name must be supplied through configuration, deployment values, parameters, environment variables, or test fixtures.
- Do not add environment-specific network identities to application code. Option classes may define protocol-neutral behavior defaults, but network locations and trust boundaries belong in `appsettings*.json`, Helm values, deployment parameters, or environment variables.
- Keep production values out of the repository. Values committed under examples, development settings, or tests must use loopback, RFC-reserved documentation names/addresses, or unmistakable placeholders and must remain overridable.
- Never commit credentials, tokens, private keys, or rendered Secrets. Reference an existing Secret and configurable key names.

## Verification

- Update contract tests when naming or configuration surfaces change.
- Before completing a change, verify there are no identifiers from the former product brand outside `refs`, generated outputs, or historical data.
- Run locked restore, Release tests, Native AOT publish, Helm lint/render checks, and applicable security scans.
