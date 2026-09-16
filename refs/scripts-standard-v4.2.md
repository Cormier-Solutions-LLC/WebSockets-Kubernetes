# SCRIPT-STANDARDS.md

> **Repository context (documentation audit):** This file preserves the imported
> Scripts Standard 4.2 reference below, including its historical product names,
> example networks and `Supersedes` metadata. Those values are not current
> Cormier.Realtime deployment defaults or proof of implemented script behavior.
> The referenced 4.1 predecessor is provenance metadata, not a bundled file.
> Current product naming and configuration boundaries are in [AGENTS.md](../AGENTS.md);
> supported entry points, prerequisites and examples are in [scripts/README.md](../scripts/README.md)
> and [the bootstrap guide](../docs/bootstrap.md).
>
> In this repository, supply network identities and trust boundaries through
> configuration. Do not import the historical private CIDRs as a TLS bypass
> allowlist: edge validation uses certificate/name validation and configurable
> CA trust as documented in [the cluster guide](../cluster/README.md).
> Repository PowerShell entry points require PowerShell 7+, with 7.4+ for the
> authenticated edge transport; the generic Windows PowerShell 5.1 guidance
> below does not override those explicit script requirements. Normative changes
> to the standard require a new version under its revisioning rules. This note
> clarifies the snapshot's context without changing its versioned rules.

Standards-Version: 4.2  
Standards-Origin: Project  
Supersedes: scripts-standard-v4.1.md  

## Purpose

This document defines the baseline scripting standards for the Propago environment. These standards should be used by default for PowerShell, Bash, Proxmox, Kubernetes, Windows, Linux, networking, automation, deployment, migration, and maintenance scripts unless a specific task requires otherwise.

The goals are:

- Predictable behavior
- Safe execution
- Clear logging
- Easy troubleshooting
- Idempotent operation where practical
- Minimal hard-coded environment assumptions
- Secure handling of credentials and secrets
- Reliable rollback and recovery
- Useful post-run verification
- Easy handoff to another administrator

---

## 1. General Script Structure

Scripts should be divided into clearly labeled phases or sections.

Recommended order:

1. Header / metadata
2. Parameters and defaults
3. Global settings
4. Logging initialization
5. Helper functions
6. Prerequisite validation
7. Credential / secret collection
8. Pre-change backup
9. Main execution phases
10. Validation / health checks
11. Cleanup
12. Summary
13. Exit code

Each major phase should print a readable status heading.

Example:

```text
================================================================================
PHASE 3 - Validate Proxmox Connectivity
================================================================================
```

---

## 2. Script Header

Each script should include a header containing:

- Script name
- Purpose
- Version
- Last updated date
- Supported platforms / versions
- Required privileges
- Expected inputs
- Output locations
- Important warnings
- Author / project where appropriate

PowerShell scripts should use comment-based help when practical.

Example:

```powershell
<#
.SYNOPSIS
    Short description.

.DESCRIPTION
    Detailed description.

.NOTES
    Version: 1.0.0
    Project: Propago
    Requires: PowerShell 7.x
#>
```

---

## 3. Versioning

Scripts should use semantic-style versioning where practical:

```text
Major.Minor.Patch
```

Examples:

```text
1.0.0
1.1.0
1.1.1
2.0.0
```

Version changes should reflect:

- Major: breaking behavior or architecture change
- Minor: new functionality
- Patch: bug fix or small correction

Generated packages may also include a timestamp.

Example:

```text
Export-ProxmoxInventory-v1.2.0-20260807-010100.ps1
```

### Standards File Revisioning

The scripting standards document itself must be versioned whenever it is changed. Existing standards files are immutable historical revisions and must not be overwritten in place.

Use this filename format for all new revisions:

```text
scripts-standard-v<major>.<minor>.md
```

For backward compatibility, a legacy filename containing only a major number is treated as `.0`. For example:

```text
scripts-standard-v1.md = scripts-standard-v1.0.md
```

Each standards file should include these metadata fields near the top of the document:

```text
Standards-Version: <major>.<minor>
Standards-Origin: Library | Project
Supersedes: <previous standards filename>
```

Version selection must use numeric semantic comparison, not lexical filename order, upload time, or modified time. Compare the major number first and the minor number second.

Examples:

```text
v2.0 is newer than v1.99
v2.10 is newer than v2.9
v3.0 is newer than v2.50
```

#### Library Revisions

A standards change made to the canonical Library copy is a major standards revision.

When revising the Library copy:

1. Discover all available `scripts-standard-v*.md` Library files.
2. Determine the highest existing major version numerically.
3. Read the latest Library standards revision before editing it.
4. Increment the major version by one.
5. Reset the minor version to `0`.
6. Create a new file using the new version number.
7. Set `Standards-Origin: Library`.
8. Set `Supersedes` to the filename used as the revision source.
9. Preserve every prior standards version unchanged.
10. Never overwrite or silently replace a prior versioned standards file.

Example:

```text
scripts-standard-v1.md
        |
        +-- Library revision --> scripts-standard-v2.0.md
        |
        +-- later Library revision --> scripts-standard-v3.0.md
```

A Library major version supersedes all standards revisions with a lower major version, including Project-local minor revisions.

#### Project Revisions

A standards change made only within an individual Project is a minor standards revision.

When revising a Project copy:

1. Discover all `scripts-standard-v*.md` files available in that Project.
2. Select the latest version using numeric major/minor comparison.
3. Read that latest version before modifying it.
4. Keep the current major version unchanged.
5. Increment the minor version by one.
6. Create a new versioned file rather than overwriting the previous file.
7. Set `Standards-Origin: Project`.
8. Set `Supersedes` to the previous Project standards filename.
9. Preserve all prior Project standards revisions unchanged.

Example:

```text
scripts-standard-v2.0.md
        |
        +-- Project revision --> scripts-standard-v2.1.md
        |
        +-- Project revision --> scripts-standard-v2.2.md
```

If a Project later receives a newer Library major revision, the newer major becomes the new baseline and supersedes Project-local revisions from older majors. Any later Project-local edits should increment the minor version from that new major baseline.

Example:

```text
Project currently has: v2.0, v2.1, v2.2
New Library release:   v3.0
Effective latest:      v3.0
Next Project revision: v3.1
```

#### Required Revision Workflow

Any request to change this standards document must follow this sequence:

```text
Discover versions
Select latest version numerically
Read latest version
Determine Library or Project revision context
Calculate next version
Create new versioned file
Preserve previous version
Verify the new file contains the requested change
Use the new file as the governing standards revision
```

Do not modify an older standards revision merely to keep copies visually synchronized. Historical versions are records of the standards that existed at that point in time.

When a versioned standards file exists, versioned files take precedence over the legacy unversioned `SCRIPT-STANDARDS.md`. The unversioned file may be retained for backward compatibility, but it must not be assumed to be the latest governing standards document.

### Script Language Selection

Generate only the scripting language requested by the user or clearly selected by the target environment and task context.

Default behavior:

- If the user requests PowerShell, generate PowerShell only. Do not also generate a Bash equivalent unless the user explicitly requests both.
- If the user requests Bash, generate Bash only. Do not also generate a PowerShell equivalent unless the user explicitly requests both.
- Generate both PowerShell and Bash only when the user explicitly requests both implementations, requests multi-platform equivalents, or otherwise clearly asks for more than one scripting language.
- If the user asks only for a `script` without naming a language, choose one appropriate language from the stated platform and surrounding context rather than automatically producing multiple implementations.
- For Windows administration, prefer PowerShell when no other language is specified.
- For Linux or Unix administration, prefer Bash when no other language is specified.
- For mixed-platform work, select the single most appropriate implementation unless the user explicitly requests separate platform-specific versions.
- Documentation may briefly mention an equivalent command or alternative language where useful, but must not include a complete second script implementation unless requested.

The existence of both PowerShell and Bash standards in this document does not imply that both script versions should be generated for a task. Each language-specific section applies only when that language is requested or selected for the task.

---

## 4. PowerShell Baseline

Apply this section when PowerShell is the requested or contextually selected scripting language. Do not generate a Bash companion implementation unless the user explicitly requests both.

PowerShell scripts should use safe, explicit, parser-compatible constructs.

General or cross-platform PowerShell scripts may target PowerShell 7 when modern functionality is useful. Windows administration scripts must be compatible with Windows PowerShell 5.1 by default unless the user explicitly requests PowerShell 7 only.

Recommended baseline:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
```

Where a script intentionally requires PowerShell 7, clearly state that requirement in the script header.

Prefer:

- Advanced functions
- Named parameters
- `CmdletBinding()`
- `try/catch/finally`
- `-ErrorAction Stop`
- Explicit return values
- Structured objects instead of formatted strings for data processing
- `Join-Path` instead of manually concatenating paths
- `Test-Path` before file operations
- `Get-Credential` or secure prompts for credentials
- Parser-safe constructs over compact string interpolation whenever ambiguity exists

Avoid:

- Hard-coded passwords
- Global variables unless justified
- Silent error suppression
- Unbounded loops
- `Write-Host` as the only logging mechanism
- Parsing formatted table output when structured data is available

### PowerShell Generation and Parser Safety

These requirements apply whenever generating or modifying PowerShell `.ps1`, `.psm1`, or `.psd1` code.

1. Never place a bare interpolated variable immediately before a colon inside a double-quoted string.

   Bad:

   ```powershell
   "$Index:"
   ```

   Good:

   ```powershell
   "${Index}:"
   ```

   Preferred when practical:

   ```powershell
   ("Index {0}:" -f $Index)
   ```

2. Do not globally rewrite or alter valid PowerShell scoped-variable syntax.

   Valid scoped variables include:

   ```powershell
   $env:PATH
   $script:Variable
   $global:Variable
   $local:Variable
   $private:Variable
   $using:Variable
   ```

   A colon that is part of a valid PowerShell scope qualifier is not an interpolation error and must not be rewritten merely because it follows a variable-related token.

3. When punctuation immediately follows an interpolated variable, prefer explicit braced interpolation or the format operator whenever parsing could be ambiguous.

   Preferred:

   ```powershell
   "${Variable}:"
   "${Variable},"
   "${Variable}."
   ("Value: {0}" -f $Variable)
   ```

4. Before delivering any generated or modified PowerShell file, perform a full-script PowerShell syntax/parser validation.

   Validation must cover the complete resulting file, not merely modified lines or individual snippets.

   Any PowerShell parser error is a blocking failure and must be corrected before the file is delivered.

5. Windows administration scripts must be validated for compatibility with Windows PowerShell 5.1 unless the user explicitly requests PowerShell 7-only functionality.

   Do not introduce PowerShell 7-only syntax, operators, cmdlets, parameters, or runtime assumptions into a Windows administration script unless that requirement is explicit.

6. When editing an existing PowerShell script, scan the entire resulting script for interpolation and parser-safety issues, including code that was not directly modified.

   In particular, check for ambiguous double-quoted interpolation such as:

   ```powershell
   "$Variable:"
   ```

   and replace it with a parser-safe form such as:

   ```powershell
   "${Variable}:"
   ```

   or:

   ```powershell
   ("{0}:" -f $Variable)
   ```

7. Never state or imply that a generated `.ps1`, `.psm1`, or `.psd1` file is complete, ready, validated, or ready to run until full-file parser validation has passed without errors.

8. When several equivalent PowerShell constructs are available, favor the construct with the clearest and safest parsing behavior over compact or clever string interpolation.

The governing principle for generated PowerShell is:

```text
Generate
Scan the complete script
Validate syntax
Fix every parser error
Validate compatibility
Deliver
```

Never:

```text
Generate
Assume it parses
Deliver
```

---

## 5. Bash Baseline

Apply this section when Bash is the requested or contextually selected scripting language. Do not generate a PowerShell companion implementation unless the user explicitly requests both.

Bash scripts should normally begin with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

Use:

```bash
IFS=$'\n\t'
```

when appropriate for safer parsing.

Always quote variable expansions unless intentional word splitting is required.

Preferred:

```bash
"$variable"
"${array[@]}"
```

Avoid:

```bash
$variable
```

when the value may contain spaces or special characters.

---

## 6. Idempotency

Scripts should be idempotent where practical.

Running the same script twice should not:

- Duplicate configuration
- Create duplicate users
- Create duplicate firewall rules
- Create duplicate storage definitions
- Append duplicate configuration lines
- Reinstall already-installed components unnecessarily

Before creating or modifying an object:

1. Check whether it already exists.
2. Compare the current state with the desired state.
3. Change only what is necessary.
4. Log whether the action was `CREATED`, `UPDATED`, `UNCHANGED`, or `SKIPPED`.

---

## 7. Prerequisite Validation

Validate all requirements needed for the script to execute successfully before performing its main work or making changes.

Prerequisite checks must cover every external capability the script depends on, including commands, modules, packages, runtimes, services, APIs, filesystem features, credentials, permissions, and supporting utilities.

Examples:

- Required command or executable exists and can be invoked
- Required command version is supported when version-specific behavior matters
- Required PowerShell module exists and can be imported
- Required package or runtime is installed
- Required service exists and is in an acceptable state
- Required API endpoint is reachable
- Required directory exists or can be created
- Required path is readable or writable as appropriate
- Required mountpoint exists
- Required filesystem is correct
- Required disk is present
- Required Kubernetes namespace exists
- Required Proxmox node exists
- Required credentials authenticate successfully
- Required permissions or privileges are available
- Required network connectivity, DNS resolution, or proxy access is available
- Required compression or archive capability is available before creating ZIP files
- Required vendor or platform CLI is installed and usable before calling it

Scripts must validate capabilities that are implied by their own behavior. For example:

- A script that archives logs must confirm that it can create ZIP archives before attempting log rotation or deletion.
- A PowerShell script using `Compress-Archive` must verify that the command is available in the target PowerShell environment, or use another explicitly supported compression method.
- A script that calls the GitHub CLI must verify that `gh` is installed and callable before using it.
- If GitHub CLI operations require authentication, validate the required authenticated state before performing dependent operations.
- A script that calls `kubectl`, `helm`, `docker`, `git`, `ssh`, `scp`, `curl`, `jq`, `pvesh`, `qm`, `pct`, or another external tool must verify that the required tool is available before reaching the phase that depends on it.

Where practical, prerequisite validation should distinguish between:

```text
MISSING       Requirement is not installed or does not exist
UNUSABLE      Requirement exists but cannot be used successfully
UNSUPPORTED   Installed version or platform is not supported
UNAUTHORIZED  Authentication or permissions are insufficient
UNREACHABLE   Required remote endpoint or service cannot be reached
READY         Requirement is available and usable
```

Failures should occur early, before destructive or configuration-changing actions and before lengthy work that cannot complete without the missing dependency.

When a required prerequisite is missing or unusable:

1. Identify the exact missing requirement.
2. Explain why the script requires it.
3. Provide a clear remediation or installation instruction when practical.
4. Preserve existing data and avoid partial destructive changes.
5. Exit with a non-zero status if the missing requirement prevents safe execution.

Do not silently install system-wide prerequisites, alter package repositories, change authentication state, or modify security policy unless dependency installation or configuration is an explicit purpose of the script.

Example status:

```text
[PASS] Proxmox API reachable
[PASS] ZIP archive capability available
[PASS] GitHub CLI found: gh 2.x
[PASS] GitHub CLI authentication valid
[FAIL] kubectl was not found
```

### TLS Certificate Validation for Trusted Private Networks

When a script accesses an HTTPS endpoint by literal IP address or by a DNS hostname that resolves to an approved private IP address, it should default to bypassing TLS certificate validation only for connections whose actual destination is within one of these trusted private networks:

```text
10.88.88.0/24
10.22.22.0/24
10.10.100.0/24
172.28.100.0/24
```

Requirements:

- Parse the destination host from the request URI or connection target.
- If the destination is a literal IPv4 address, perform a real CIDR membership check before enabling the bypass. Do not use string-prefix matching.
- If the destination is a DNS hostname, resolve its A records before the connection attempt and evaluate the returned IPv4 addresses using real CIDR membership checks.
- A DNS hostname qualifies automatically when all usable resolved IPv4 addresses are inside the approved networks.
- If DNS returns a mixture of approved and unapproved addresses, retain normal certificate validation unless the script explicitly pins the connection to a selected approved address while preserving the original hostname for the HTTP Host header and TLS SNI where supported.
- When the client or runtime exposes the connected peer address, verify that the actual peer IP is approved. Do not rely only on an earlier DNS result when the actual connection destination can be checked.
- Re-resolve the hostname for each new connection or authentication retry unless the client is intentionally reusing an existing verified connection.
- DNS lookup failure, an empty result, an IPv6-only result, or an address outside the approved networks must not enable the bypass.
- Re-evaluate every redirected destination independently. Do not carry an insecure client, handler, session, or certificate callback to a redirect target that has not qualified.
- Scope the bypass to the individual request, connection, client instance, or command whenever the language or tool supports that scope.
- Do not disable certificate validation globally for the entire process, user profile, operating system, or unrelated requests.
- Keep TLS encryption enabled. This exception bypasses certificate identity, chain, expiration, or trust validation; it must not downgrade HTTPS to HTTP.
- Log a warning that certificate validation was bypassed, including the requested hostname when applicable, the resolved or connected destination IP, and the matching trusted CIDR. Never log credentials, tokens, cookies, or authorization headers.
- Provide an explicit strict-validation parameter or option when practical so an operator can force normal certificate validation even for these trusted private networks.
- A task-specific requirement to validate certificates always, use a supplied CA, or trust a specific certificate overrides this default.
- Any destination outside the listed networks must use normal TLS certificate validation unless the user explicitly authorizes an exception for that task.
- Prefer importing the correct internal CA or using a valid certificate as the durable remediation. Treat this bypass as an environment compatibility default, not proof that the endpoint is authentic.
- When a CLI or SDK provides only a command-specific insecure option, use it only for the qualifying request. Examples include `curl --insecure`, `wget --no-check-certificate`, and the corresponding per-request or per-client option in the selected language.
- If a runtime lacks a per-request bypass and requires a temporary callback or process-level setting, save the prior value, limit the affected code block, restore the prior value in guaranteed cleanup, and do not run unrelated concurrent HTTPS operations while the temporary bypass is active.

The normal decision flow should be:

```text
Parse destination
If destination is a literal IPv4 address:
    Evaluate the address against the approved CIDRs
Else:
    Resolve the hostname to IPv4 addresses
    Evaluate all usable addresses against the approved CIDRs
    If results are mixed:
        Require normal validation or pin to an approved address safely
If the actual or safely selected destination is approved
and strict validation was not requested:
    Keep HTTPS enabled
    Bypass certificate validation for this request only
    Log the hostname, destination IP, and matching CIDR
Else:
    Use normal certificate validation
For every redirect:
    Repeat the complete decision process
```

### Concurrency, Parallelism, and Lock Coordination

Scripts should evaluate whether independent work can be processed concurrently whenever the workload contains multiple targets, hosts, files, records, API calls, jobs, or other units that do not require strict serial execution.

For workloads that can safely benefit from concurrency:

- Prefer bounded asynchronous or parallel processing instead of unnecessary one-at-a-time execution.
- Expose concurrency through a clear parameter such as `-Parallel`, `-ThrottleLimit`, `-MaxConcurrency`, or the language-appropriate equivalent.
- For interactive scripts, if concurrency is safe and materially useful but the user has not supplied a choice, the script may prompt once to enable it or choose a throttle limit.
- For unattended or automation-oriented scripts, do not require an interactive prompt; accept parameters and use documented safe defaults.
- Use a conservative default throttle rather than spawning an unbounded number of workers.
- Allow concurrency to be disabled for troubleshooting, compatibility, rate-limit, or safety reasons.
- Respect API rate limits, service limits, CPU, memory, network capacity, remote-session limits, and other resource constraints when determining concurrency.

A common pattern for multi-server work should be:

```text
Collect or accept target data
Validate all targets and prerequisites
Determine safe concurrency / throttle
Create independent work items
Process work items concurrently
Coordinate access to shared resources
Collect per-item results
Wait for all workers to complete
Validate outcomes
Produce one consolidated summary
```

For example, a script configuring twelve independent servers should generally collect the server data up front or accept it as structured input, then dispatch independent workers for those servers when the operations can safely run in parallel. It should not repeatedly prompt each worker for information that could have been collected once before parallel execution begins.

#### Worker Scope and State

Concurrent workers must not assume they automatically inherit the parent execution scope.

Functions, variables, configuration, credentials, modules, helper code, and other required state must be explicitly made available to each worker by using the appropriate mechanism for the scripting environment.

Requirements include:

- Pass target-specific values into the worker explicitly.
- Pass or recreate required configuration and immutable shared values explicitly.
- Import required modules or dependencies inside the worker when the concurrency model requires a separate execution context.
- Make helper functions available to the worker explicitly when they are not automatically inherited.
- Avoid depending on mutable global state shared implicitly between workers.
- Do not assume thread, runspace, process, job, or remote-session scopes behave identically.
- Ensure credentials and secrets are passed using the safest mechanism supported by the target environment and are not exposed in logs or command-line arguments unnecessarily.
- Return structured per-worker results rather than relying on interleaved console output as the only result channel.

For PowerShell, this applies to runspaces, thread jobs, background jobs, `ForEach-Object -Parallel`, remoting sessions, and other parallel execution models. Variables and functions required inside a new runspace or worker must be passed, imported, recreated, or otherwise intentionally exposed to that worker.

#### Shared State, Read Locks, and Write Locks

When concurrent workers may access the same mutable resource, scripts must implement coordination rather than relying on timing or luck.

Shared resources may include:

- Log files
- State files
- CSV or JSON output files
- Databases
- Configuration files
- Shared directories
- API objects
- Cluster-wide configuration
- Counters, queues, caches, or in-memory collections

Where lock contention is possible, the script should support the equivalent of:

```text
Check lock state
Request / claim lock
Wait or queue if lock is unavailable
Perform protected operation
Release lock
Record lock or timeout failures
```

Locking requirements:

- Distinguish read/shared access from write/exclusive access when the platform provides that capability.
- Allow multiple safe readers concurrently when appropriate.
- Require exclusive ownership for writes or other mutually exclusive operations.
- Check whether a required lock can be obtained before modifying a protected resource.
- Queue or wait when the lock is held, using a bounded timeout and an appropriate retry delay or backoff.
- Never wait indefinitely for a lock.
- Release locks in `finally`, deferred cleanup, context-manager, trap, or equivalent guaranteed-cleanup logic.
- Release locks when a worker fails, times out, or is cancelled whenever the platform permits safe cleanup.
- Log lock acquisition, contention, timeout, and release when those events are useful for troubleshooting.
- Avoid deadlocks by using a consistent lock acquisition order when more than one lock is required.
- Keep the protected critical section as small as practical.
- Do not hold a write lock while performing unrelated slow network operations unless the protected operation genuinely requires it.

Where the platform offers suitable synchronization primitives, prefer established mechanisms such as mutexes, semaphores, reader/writer locks, file locks, synchronized queues, atomic operations, database transactions, or service-native locking rather than inventing fragile ad-hoc lock files.

If a lock-file mechanism is necessary, the script must define ownership, stale-lock detection, timeout behavior, cleanup, and how it avoids deleting a lock that belongs to another active worker.

#### Concurrent Logging and Result Collection

Parallel workers should not independently write unsynchronized data to the same file when that could interleave, truncate, corrupt, or reorder output.

Prefer one of these patterns:

- A synchronized logging function protected by a lock
- A thread-safe or process-safe queue consumed by a single log writer
- Per-worker temporary logs merged after completion
- A platform-native concurrent logging mechanism

Likewise, collect results through thread-safe collections, queues, job results, or worker return objects, then produce the final summary after all workers have completed or timed out.

Concurrency must improve throughput without sacrificing determinism, validation, recoverability, logging clarity, or data integrity. When safe concurrency cannot be guaranteed, prefer serial execution and explain why.

---

## 8. Credentials and Secrets

Credentials and secrets require both script-level protection and session-level exposure handling.

### Common Credential Collection and Reauthentication

Interactive scripts that require authentication should identify their credential sets before the main execution phases and prompt for commonly reused credentials once near the start of the run.

Requirements:

- Determine which targets use the same credential set and collect that credential once for the group rather than prompting separately for every device or connection.
- Do not assume that unrelated systems share credentials merely because the same username might work. Group credentials only when the script design, supplied configuration, or operator identifies them as common.
- Collect credentials after basic prerequisites and target definitions are validated but before the first authenticated operation.
- Use secure, non-echoing prompts and platform-native credential objects where available.
- Reuse an in-memory credential only for its intended targets and only for the current execution unless an approved credential store is explicitly part of the design.
- Never print or log passwords, private keys, tokens, session cookies, authorization headers, or credential-object contents.
- Scripts with unattended or non-interactive modes must accept an approved non-interactive credential source and must not unexpectedly pause for input.

When an operation returns an authentication or authorization failure attributable to a known credential set, the script must stop dependent work and prompt the operator to choose one of these actions:

```text
[R] Re-enter the affected credential set
[Q] Quit safely
```

The prompt should identify the affected credential set and target without displaying the secret. Re-entering must replace the failed in-memory credential for that credential group and retry only the failed authentication-dependent operation when retrying is safe.

Common authentication and authorization indicators include:

- HTTP `401 Unauthorized`
- HTTP `403 Forbidden` when the API or service indicates that authentication, token scope, account authorization, or session validity is the cause
- REST or API responses such as invalid credentials, invalid token, expired token, expired session, authentication required, access denied, or not authorized
- SSH messages such as `Permission denied`, `Permission denied (publickey)`, `Permission denied (password)`, `Authentication failed`, `Too many authentication failures`, or an SSH exit status associated with failed authentication
- PowerShell remoting or WinRM messages such as `Access is denied`, logon failure, invalid credentials, unauthorized, or a `PSSessionOpenFailed` / remoting transport error whose underlying cause is authentication
- SMB or Windows errors such as access denied, system error 5, unknown user name or bad password, or logon failure error 1326
- CLI or SDK errors that explicitly report an unauthenticated, unauthorized, expired-session, expired-token, rejected-key, or credential-validation failure

Do not treat every transport failure as a credential failure. DNS failures, refused connections, unreachable hosts, TLS negotiation or certificate errors, timeouts, routing failures, and service-unavailable responses should follow their own error handling and must not trigger a credential prompt unless the returned diagnostic also clearly identifies authentication as the cause.

Reauthentication behavior must also follow these rules:

- Do not retry rejected credentials automatically in a loop.
- After each recognized credential failure, offer re-entry or safe quit.
- Use a conservative configurable retry limit, defaulting to three re-entry attempts per credential set, to reduce account-lockout risk.
- When the retry limit is reached, stop dependent work and exit with the authentication failure code.
- Clear or replace invalid cached credentials, tokens, cookies, sessions, and authenticated client objects before retrying.
- Recreate the affected authenticated connection or client after credentials are replaced.
- Do not restart completed work unnecessarily. Retry the smallest safe operation.
- Before retrying a state-changing operation whose result is uncertain, query the remote state or otherwise prove that the earlier attempt did not already succeed.
- In parallel scripts, coordinate reauthentication in the parent or controlling scope. Pause new work for the affected credential group, allow only one credential prompt, replace the shared credential atomically, then resume or retry affected workers safely.
- A user choice to quit must perform normal cleanup, preserve logs and backups, summarize incomplete work, and exit non-zero without continuing with other operations that depend on the failed credential.
- In unattended mode, record the affected credential set and target, provide actionable remediation, and exit with the authentication failure code instead of prompting.

The normal interactive flow should be:

```text
Identify targets and credential groups
Validate non-authentication prerequisites
Prompt once for each required common credential set
Perform authenticated work
If a recognized authentication or authorization failure occurs:
    Pause dependent work
    Offer Re-enter credential set or Quit
    If Re-enter:
        Replace cached authentication state
        Reconnect
        Retry the smallest safe operation
    If Quit or retry limit reached:
        Clean up
        Summarize
        Exit with authentication failure
```

### Session-Level Secret Exposure Detection

When a user provides a value in the current GPT session that appears to be a real password, API token, private key, certificate password, cloud secret, service-account secret, or similar credential, treat it as potentially exposed.

The assistant should:

1. Immediately warn the user that a credential appears to have been exposed in the conversation.
2. Identify the affected account, service, or credential type when that context is available, but do not repeat the literal secret value in the warning.
3. Recommend rotating or changing the credential when the value appears to be a real active secret.
4. Avoid unnecessarily reproducing the secret in explanatory text, logs, summaries, comments, filenames, or other output.
5. Redact the secret anywhere it does not need to appear literally.
6. If the credential is clearly being supplied intentionally for the current task and the task requires using it, the assistant may use the provided value as requested after issuing the exposure warning, while minimizing where the value is propagated.

A value should not be treated as an accidental exposure when the context clearly shows that the user is requesting a placeholder, template value, example credential, or sentinel value rather than supplying a real secret.

Examples of obvious placeholders include values such as:

```text
CHANGE_ME
PASSWORD_HERE
<PASSWORD>
<SECRET>
REPLACE_WITH_PASSWORD
```

Do not mistake an obvious placeholder for a real credential merely because it appears in a password field.

### Placeholder Password Behavior

When the user asks for a password placeholder to be embedded in a generated script, use a clearly recognizable placeholder value and make the script detect whether that placeholder remains unchanged at runtime.

The normal pattern should be:

```text
Define explicit placeholder value
Check value at runtime
If value still equals placeholder:
    Prompt securely for the password or secret
Else:
    Use the supplied/replaced value
Continue without printing the secret
```

Requirements:

- The placeholder comparison must be explicit and deterministic.
- If the placeholder has not been replaced, prompt securely rather than attempting authentication with the placeholder.
- If the placeholder has been replaced with a non-placeholder value, use that value for the intended operation.
- Do not display the entered or embedded password back to the console.
- Do not write the password to normal logs.
- Do not include the password in exception messages, debug output, command history, process arguments, URLs, or generated reports when a safer mechanism is available.
- Prefer secure-string, credential-object, secret-store, environment-variable, protected-file, or equivalent mechanisms when supported by the platform.

For PowerShell, a placeholder pattern may resemble:

```powershell
$PasswordPlaceholder = 'CHANGE_ME'
$Password = $PasswordPlaceholder

if ($Password -eq $PasswordPlaceholder) {
    $SecurePassword = Read-Host 'Enter password' -AsSecureString
}
else {
    $SecurePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
}
```

The exact implementation may vary based on PowerShell version, target platform, and authentication mechanism. Prefer a secure credential object or secret source when the receiving API or command supports one.

For Bash, use a non-echoing prompt such as `read -s` when a placeholder remains unchanged, and avoid exposing literal credentials through command-line arguments where they may be visible to other processes.

### Hard-Coded Secret Rules

Do not introduce a real hard-coded credential merely for convenience when the user has not supplied or requested one.

Never invent:

- Passwords
- API tokens
- Private keys
- Certificate passwords
- Cloud secrets
- Service account secrets

Prefer:

- Secure prompts
- Environment variables
- Secret stores
- Existing credential files with correct permissions
- API token files where appropriate
- Platform-native credential objects or vault integrations

If the user explicitly provides a real credential for a task, the session-level exposure warning above still applies. If the requested script is intended to contain that literal credential, warn that the secret will be embedded in the artifact and use it only where required by the task.

Credentials should not be written to logs.

When logging API requests, redact:

```text
Authorization
Password
Token
Secret
PrivateKey
Cookie
```

Temporary password or secret files should be deleted after successful use when they are no longer required.

---

## 9. Backups Before Changes

Scripts that modify meaningful configuration should create a backup before making changes.

Examples include:

- Proxmox cluster configuration
- `/etc/pve/*`
- Network configuration
- Firewall configuration
- Load balancer configuration
- Kubernetes manifests
- Certificates
- Application configuration
- Windows registry areas
- IIS configuration
- SQL configuration

Backups should include timestamps.

Example:

```text
config.2026-08-07.010100.bak
```

Where practical, create one backup at the beginning of the run rather than repeatedly backing up the same unchanged configuration during every phase.

---

## 10. Logging

Every non-trivial script should produce a log.

Recommended log format:

```text
[2026-08-07 01:01:00] [INFO] Starting export
[2026-08-07 01:01:01] [PASS] Connected to Proxmox API
[2026-08-07 01:01:02] [WARN] Guest agent unavailable for VM 2001
[2026-08-07 01:01:03] [ERROR] Failed to query storage thin-extra
```

Recommended levels:

- DEBUG
- INFO
- PASS
- WARN
- ERROR
- FATAL

Logs should include:

- Timestamp
- Phase
- Action
- Object being processed
- Error message
- Relevant command or API endpoint when useful

Do not log secrets.

### Log Archiving and Retention

Scripts that create or manage log files should perform log housekeeping once per execution unless a task-specific requirement explicitly overrides it.

Default log housekeeping behavior:

- Keep the current execution log and logs from the most recent 7 days uncompressed.
- Identify completed log files older than 7 days using the file's last-modified time or another reliable log timestamp.
- Compress logs older than 7 days into ZIP archives.
- Store archives in an `Archive` subdirectory beneath the script's normal log directory unless another archive location is explicitly configured.
- Prefer clear date-based archive names, such as `Logs-2026-08-01.zip`, or another naming scheme that makes the archived date range obvious.
- Never include the active log file for the current script execution in an archive.
- Verify that the ZIP archive was created successfully, is non-zero in size, and can be opened or enumerated before removing any source log files.
- Delete original log files only after successful archive validation.
- If compression or archive validation fails, preserve the original logs and record a warning or error rather than deleting them.
- Do not repeatedly recompress existing ZIP archives.
- Log the number of files archived, the archive path, and any files skipped or left in place because of an error.
- Do not delete archived logs unless a separate archive-retention policy is explicitly defined.

The normal lifecycle should be:

```text
Write logs
Keep 7 days readily accessible
Archive older logs to ZIP
Validate archive
Remove successfully archived source logs
Retain archives according to the applicable retention policy
```

This housekeeping should be automatic and should not require interactive confirmation during a normal script run.

---

## 11. Console Output

Console output should be readable and useful while the script is running.

Use consistent status indicators:

```text
[INFO]
[PASS]
[WARN]
[FAIL]
[SKIP]
```

Avoid excessive noise.

Important events should be easy to identify without reviewing the full log.

---

## 12. Error Handling

Errors should be handled intentionally.

Scripts should distinguish between:

### Fatal errors

Execution cannot safely continue.

Examples:

- Authentication failure
- Required storage missing
- Required disk missing
- Backup could not be created
- Invalid configuration input

The script should stop with a non-zero exit code.

### Non-fatal errors

A specific item failed but the rest of the process can continue.

Examples:

- One VM does not have a guest agent
- One optional API query is unavailable
- One inactive interface does not return runtime information

These should be logged and included in the final summary.

---

## 13. Timeouts and Wait Loops

Never wait forever.

Any polling loop should have:

- Maximum attempts
- Maximum elapsed time
- Delay between attempts
- Clear timeout error

Example:

```text
Waiting for SSH: attempt 4 of 30
```

At timeout:

```text
[FAIL] SSH did not become available within 300 seconds.
```

---

## 14. Input Validation

Validate user input before using it.

Examples:

- IP address format
- CIDR format
- Hostname format
- VLAN range
- Port number
- VMID
- Path existence
- File extension
- Certificate format
- URL format

If a value is invalid, explain what is expected.

---

## 15. Paths and Directories

Scripts should:

- Create required directories automatically
- Validate that target paths are writable
- Avoid assuming the current working directory
- Use absolute paths for important operations
- Quote paths containing spaces
- Avoid destructive wildcard deletes

Before deleting a directory or file:

1. Validate the resolved path.
2. Ensure it is the intended location.
3. Log the action.

---

## 16. Destructive Actions

Potentially destructive actions should be explicit.

Examples:

- Delete VM
- Destroy storage
- Remove cluster node
- Remove firewall rule
- Delete certificate
- Clear database
- Format disk
- Wipe partition table
- Remove package
- Delete Kubernetes namespace

Where practical, support:

```text
-DryRun
-WhatIf
-Force
```

A script should never silently perform destructive cleanup outside its clearly defined working area.

---

## 17. External Downloads

When downloading external files:

- Use HTTPS
- Prefer official vendor or project sources
- Verify download success
- Validate file existence and non-zero size
- Validate checksum where available
- Log the source URL
- Avoid piping remote scripts directly into privileged shells unless explicitly required and understood

Preferred approach:

```text
Download
Verify
Inspect
Execute
```

rather than:

```bash
curl ... | bash
```

---

## 18. Package Installation

Before installing packages:

1. Check if the package is already installed.
2. Update package metadata only when required.
3. Install only required packages.
4. Log newly installed packages.

Avoid performing unnecessary full system upgrades unless the script is specifically intended to do so.

---

## 19. Service Management

Before restarting or reloading a service:

- Validate configuration if a validation command exists.
- Back up the current configuration.
- Prefer reload over restart when appropriate.

After changing a service:

1. Check service state.
2. Check recent service logs.
3. Verify listening ports if applicable.
4. Verify application-level health.

---

## 20. Network Changes

Network configuration scripts require extra safeguards.

Before applying changes:

- Capture current interface configuration
- Capture routing table
- Capture DNS configuration
- Capture bridge/bond configuration
- Validate target gateway
- Validate target IP/CIDR
- Ensure the management path is understood

Whenever possible, provide a rollback path before applying network changes.

---

## 21. Proxmox-Specific Standards

When modifying Proxmox configuration, scripts should be especially careful with `/etc/pve`.

Relevant files may include:

```text
/etc/pve/user.cfg
/etc/pve/domains.cfg
/etc/pve/storage.cfg
/etc/pve/datacenter.cfg
/etc/pve/corosync.conf
/etc/pve/nodes/<node>/qemu-server/
/etc/pve/nodes/<node>/lxc/
```

Before modifying Proxmox authentication or realm configuration, back up at minimum:

```text
/etc/pve/user.cfg
/etc/pve/domains.cfg
```

Before modifying storage:

```text
/etc/pve/storage.cfg
```

Before modifying cluster networking or quorum-sensitive configuration, capture the current cluster state.

Useful pre-change checks include:

```bash
pvecm status
pvesh get /cluster/status
pvesh get /cluster/resources
pvesm status
```

Do not assume every node has identical local storage or network device names.

---

## 22. Kubernetes-Specific Standards

Before applying Kubernetes changes:

- Confirm current context
- Confirm cluster
- Confirm namespace
- Validate YAML
- Check that referenced secrets/configmaps exist
- Capture the existing resource before modification

Recommended:

```bash
kubectl config current-context
kubectl get namespace
kubectl diff -f manifest.yaml
kubectl apply --dry-run=server -f manifest.yaml
```

Environment/application naming should follow the Propago naming convention:

```text
<environment>-<application>
```

Examples:

```text
test-elastic
test-kibana
dev-elastic
prod-kibana
```

Avoid:

```text
elastic-test
kibana-test
testuat-elastic
```

---

## 23. Output Data

Scripts that perform discovery, audit, inventory, or migration analysis should output structured data in addition to console text.

Preferred formats:

- CSV for easy human comparison
- JSON for full fidelity
- TXT for human-readable summaries
- ZIP for complete export packages

Inventory scripts should retain raw data where practical.

Example:

```text
Export-20260807-010100/
├── Summary.csv
├── Hosts.csv
├── Guests.csv
├── Storage.csv
├── Errors.csv
├── README.txt
└── Raw/
    ├── cluster.json
    ├── nodes/
    └── guests/
```

---

## 24. Final Validation

Every script that makes changes should verify the result.

Do not treat a successful command exit as sufficient proof.

Examples:

### Web service

```text
HTTP response
Expected text in response
Listening port
Service status
```

### Proxmox

```text
pvesh query
qm config
pct config
pvesm status
pvecm status
```

### Kubernetes

```text
kubectl get
kubectl describe
kubectl rollout status
```

### Windows service

```powershell
Get-Service
Test-NetConnection
Invoke-WebRequest
```

---

## 25. Final Summary

Every substantial script should finish with a concise summary.

Example:

```text
================================================================================
SUMMARY
================================================================================

Hosts processed:       4
Guests processed:      82
Objects changed:       7
Objects unchanged:     68
Warnings:              3
Errors:                0

Backup:
C:\Backups\config-20260807-010100.zip

Log:
C:\Logs\Deploy-20260807-010100.log

Status: SUCCESS
```

---

## 26. Exit Codes

Use meaningful exit codes.

At minimum:

```text
0 = Success
1 = Failure
```

For larger automation packages, additional codes may be used.

Example:

```text
0  Success
1  General failure
2  Invalid parameters
3  Prerequisite failure
4  Authentication failure
5  Backup failure
6  Validation failure
```

---

## 27. README for Script Packages

Multi-file script packages should include a README describing:

- Purpose
- Requirements
- Supported systems
- Files included
- How to run
- Parameters
- Expected output
- Rollback procedure
- Known limitations
- Troubleshooting
- Version

---

## 28. Commenting Style

Comments should explain:

- Why something is being done
- Non-obvious dependencies
- Risky or unusual behavior
- Workarounds
- External assumptions

Avoid comments that simply repeat the code.

Bad:

```powershell
# Set variable x
$x = 5
```

Better:

```powershell
# Proxmox requires VMIDs to be unique cluster-wide, so reserve this range
# for dynamically created test workers.
$StartingVmId = 8000
```

---

## 29. Default Safety Principle

When uncertain, scripts should favor:

```text
Inspect
Validate
Back up
Change
Verify
```

rather than:

```text
Change
Hope
```

---

## 30. Propago Default Script Philosophy

Unless explicitly requested otherwise, scripts generated for this project should aim to be:

- Safe
- Repeatable
- Verbose enough to troubleshoot
- Automated enough to run end-to-end
- Interactive only where credentials or genuinely variable values are required
- Capable of surviving a partial failure
- Clear about what changed
- Clear about what did not change
- Easy to hand to another administrator
- Easy to rerun after correcting an issue

This document should be treated as the default baseline for future Propago scripting work unless a task-specific requirement overrides it.
