<#
.SYNOPSIS
Creates or updates the Kubernetes Secret used by managed Redis and the gateway.
.DESCRIPTION
Reads two password files, removes trailing CR/LF bytes, rejects embedded newlines,
and submits the Secret to kubectl through standard input so passwords are not placed
in command-line arguments or output.
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
    [Parameter(Mandatory)][string]$Context,
    [Parameter(Mandatory)][string]$Namespace,
    [Parameter(Mandatory)][string]$SecretName,
    [Parameter(Mandatory)][string]$AdminInputFile,
    [Parameter(Mandatory)][string]$RealtimeInputFile,
    [string]$AdminKey = 'redis-password',
    [string]$RealtimeKey = 'realtime',
    [switch]$CreateNamespace,
    [switch]$DryRun,
    [string]$Kubectl = 'kubectl'
)

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or later is required but node was not found on PATH.' }
$arguments = @(
    (Join-Path $PSScriptRoot 'realtime-redis-secret.mjs'),
    '--context', $Context,
    '--namespace', $Namespace,
    '--secret-name', $SecretName,
    '--admin-password-file', $AdminInputFile,
    '--realtime-password-file', $RealtimeInputFile,
    '--admin-key', $AdminKey,
    '--realtime-key', $RealtimeKey,
    '--kubectl', $Kubectl
)
if ($CreateNamespace) { $arguments += '--create-namespace' }
if ($DryRun) { $arguments += '--dry-run' }
& $node.Source @arguments
exit $LASTEXITCODE
