# Security policy


Security is part of the Cormier Realtime Gateway contract. This policy covers the gateway, reusable .NET packages, TypeScript/browser client, protocol, lifecycle automation, deployment assets, and reference applications maintained in this repository.

## Supported versions

The project is currently pre-release. The repository has no published GitHub release or supported production release line.

| Version or branch | Security support |
| --- | --- |
| `main` | Active development; accepted fixes are applied here |
| Unreleased `0.1.0` artifacts | Evaluation only; not a supported production release |
| Any other build, branch, fork, or modified artifact | Not supported by this repository |

This table will be replaced with explicit release ranges when the first supported release is published. A commit, package, container image, npm artifact, or Helm chart built from `main` is not a supported release unless it is identified by the repository's release process.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a GitHub issue, discussion, pull request, commit message, CI log, or other public or broadly visible channel. Do not include credentials, tokens, cookies, private keys, production configuration, customer data, or exploit material in ordinary project tickets.

Because this is an internal repository and GitHub private vulnerability reporting is not currently enabled, contact the Cormier Solutions security team or a repository administrator through an organization-approved private channel. Repository administrators can create a private draft security advisory under the repository's **Security** tab and add the reporter as a collaborator when coordinated investigation is needed.

Include the following when available:

- the affected component, package, image, chart, script, endpoint, or commit;
- the observed and expected behavior;
- reproducible steps or a minimal proof of concept that does not contain live secrets or customer data;
- the security impact, required access, and deployment assumptions;
- relevant configuration with all sensitive values redacted; and
- any known workaround or mitigation.

If the report contains sensitive attachments, ask the recipient to establish an approved encrypted transfer method before sending them. If a secret may have been exposed, rotate or revoke it through its owning system immediately; removing it from Git history is not sufficient.

No fixed acknowledgement or remediation SLA is currently published. Maintainers will acknowledge valid reports through the private channel, reproduce and assess the issue, coordinate a fix and validation, and agree on disclosure timing with the reporter. Please allow a reasonable opportunity to remediate before disclosure.

## Coordinated disclosure

Keep the report and technical details private until maintainers confirm that affected supported artifacts are fixed or mitigated. When a release process exists, remediation may include updated packages, an immutable container digest, chart or configuration changes, upgrade or rollback instructions, and a GitHub security advisory. Credit will be coordinated with the reporter unless anonymity is requested.

The repository does not currently operate a bug-bounty program and makes no promise of payment or reward.

## Security boundaries for deployments

The repository's examples are safe development placeholders, not production values. Operators remain responsible for the security of their identities, infrastructure, network, cluster, registry, Secret provider, TLS configuration, data, and deployment-specific policy.

- Keep credentials and key material in an approved Secret provider. Bootstrap and deployment automation references existing Kubernetes Secrets; it must not create, read, render, or commit secret values.
- Supply domains, origins, endpoints, addresses, CIDRs, ports, registries, cluster identities, namespaces, and Secret names through configuration. Review generated, redacted plans before mutation.
- Terminate production traffic with TLS. Configure exact allowed origins and trusted proxy networks, and do not enable insecure client credential transport outside an isolated test environment.
- Treat sessions and connection tickets as credentials. Tickets are short-lived and single-use; session validity and authorization must be revalidated according to the hosting application's trust model.
- Keep diagnostics disabled unless required. Production diagnostics and protected metrics require explicit enablement, authorization, origin/network restrictions, and separate credentials. Never expose them through an unrestricted public route.
- Use least-privilege identities for CI, registry, Kubernetes, Redis, monitoring, and release operations. Review NetworkPolicy, ingress, egress, pod-security, and managed/external Redis choices for the target environment.
- Deploy immutable image digests and retain the release evidence needed to verify source commit, archive checksum, registry/repository, credential provider, and published digest.

See the [architecture](docs/architecture.md), [protocol](docs/protocol.md), [bootstrap guide](docs/bootstrap.md), [developer guide](docs/developer-guide.md), [operator runbooks](docs/runbooks/README.md), and [diagnostics runbook](docs/runbooks/diagnostics.md) for the detailed contracts behind these boundaries.

## Repository security checks

Default-branch CI validates locked dependency restoration, analyzers, tests, Native AOT publication, cross-shell bootstrap behavior, Helm/Kubernetes rendering, clean package consumers, browser/reference-stack behavior, and rootless read-only container execution. It scans source, packages, reference images, and the deployable OCI archive with Trivy, uploads SARIF where permitted, and generates SPDX SBOM artifacts. Repository secret scanning, push protection, and Dependabot security updates are enabled.

These controls reduce risk but do not replace review, threat modeling, environment-specific hardening, dependency triage, penetration testing, or incident response.

## Out of scope and safe testing

Use repository-owned test fixtures or an explicitly authorized non-production environment. Do not test against production, customer systems, or third-party infrastructure without written authorization. Stop if testing risks data loss, privacy impact, service degradation, credential exposure, or access beyond the agreed scope.

The following are not treated as repository vulnerabilities unless they demonstrate a concrete impact in maintained code or deployment assets:

- unsupported forks, locally modified artifacts, or obsolete dependencies outside this repository;
- missing controls in an operator environment that contradict the documented deployment requirements;
- social engineering, physical attacks, or denial-of-service/load testing without prior authorization;
- automated scanner output without a reproducible affected path and security impact; and
- disclosure of example values that are explicitly reserved placeholders and are not usable credentials.
