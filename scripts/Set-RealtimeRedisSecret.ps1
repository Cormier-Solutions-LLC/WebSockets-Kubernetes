<#
.SYNOPSIS
Creates or updates the Kubernetes Secret used by managed Redis and the gateway.
.DESCRIPTION
Reads two password files, removes trailing CR/LF bytes, rejects whitespace-only
or embedded-newline values,
and submits the Secret to kubectl through standard input so passwords are not placed
in command-line arguments or output. Config mode derives all Kubernetes and Secret
identities from the validated bootstrap configuration and avoids duplicated values.
.PARAMETER Config
Bootstrap JSON configuration. Do not combine with Context, Namespace, SecretName,
AdminKey, or RealtimeKey.
.PARAMETER Context
Exact kubectl context to target.
.PARAMETER Namespace
Kubernetes namespace containing Redis and the gateway.
.PARAMETER SecretName
Name of the existing Secret referenced by both Helm releases.
.PARAMETER AdminInputFile
File containing the Redis default/admin password.
.PARAMETER RealtimeInputFile
File containing the restricted realtime ACL user's password.
.PARAMETER AdminKey
Secret data key for the administrator password.
.PARAMETER RealtimeKey
Secret data key and managed Redis ACL username.
.PARAMETER CreateNamespace
Create the namespace when it does not exist.
.PARAMETER DryRun
Validate the files and target identifiers without contacting Kubernetes.
#>
[CmdletBinding()]
param(
    [string]$Config,
    [string]$Context,
    [string]$Namespace,
    [string]$SecretName,
    [Parameter(Mandatory)][string]$AdminInputFile,
    [Parameter(Mandatory)][string]$RealtimeInputFile,
    [string]$AdminKey,
    [string]$RealtimeKey,
    [switch]$CreateNamespace,
    [switch]$DryRun,
    [string]$Kubectl = 'kubectl'
)

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or later is required but node was not found on PATH.' }
$arguments = @(
    (Join-Path $PSScriptRoot 'realtime-redis-secret.mjs'),
    '--admin-password-file', $AdminInputFile,
    '--realtime-password-file', $RealtimeInputFile,
    '--kubectl', $Kubectl
)
if ($Config) { $arguments += @('--config', $Config) }
if ($Context) { $arguments += @('--context', $Context) }
if ($Namespace) { $arguments += @('--namespace', $Namespace) }
if ($SecretName) { $arguments += @('--secret-name', $SecretName) }
if ($AdminKey) { $arguments += @('--admin-key', $AdminKey) }
if ($RealtimeKey) { $arguments += @('--realtime-key', $RealtimeKey) }
if ($CreateNamespace) { $arguments += '--create-namespace' }
if ($DryRun) { $arguments += '--dry-run' }
& $node.Source @arguments
exit $LASTEXITCODE
