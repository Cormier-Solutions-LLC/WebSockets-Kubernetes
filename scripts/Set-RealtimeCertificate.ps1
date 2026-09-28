<#
.SYNOPSIS
Creates or updates the cert-manager Certificate referenced by the gateway.
.DESCRIPTION
Uses the validated bootstrap configuration as the source of Kubernetes context,
namespace, DNS name, Certificate name, and TLS Secret name. The command waits for
Ready=True so gateway installation cannot race a missing TLS Secret.
.PARAMETER Config
Path to the versioned bootstrap JSON configuration.
.PARAMETER IssuerName
Name of the existing cert-manager ClusterIssuer or namespaced Issuer.
.PARAMETER IssuerKind
ClusterIssuer (default) or Issuer.
.PARAMETER IssuerGroup
Issuer API group. Defaults to cert-manager.io.
.PARAMETER CreateNamespace
Create the configured namespace when it does not exist.
.PARAMETER TimeoutSeconds
Bound the Certificate readiness wait from 60 through 1800 seconds.
.PARAMETER DryRun
Validate inputs and report the derived target without contacting Kubernetes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$IssuerName,
    [ValidateSet('ClusterIssuer', 'Issuer')][string]$IssuerKind = 'ClusterIssuer',
    [string]$IssuerGroup = 'cert-manager.io',
    [ValidateRange(60, 1800)][int]$TimeoutSeconds = 300,
    [switch]$CreateNamespace,
    [switch]$DryRun,
    [string]$Kubectl = 'kubectl'
)

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or later is required but node was not found on PATH.' }
$arguments = @(
    (Join-Path $PSScriptRoot 'realtime-certificate.mjs'),
    '--config', $Config,
    '--issuer-name', $IssuerName,
    '--issuer-kind', $IssuerKind,
    '--issuer-group', $IssuerGroup,
    '--timeout-seconds', [string]$TimeoutSeconds,
    '--kubectl', $Kubectl
)
if ($CreateNamespace) { $arguments += '--create-namespace' }
if ($DryRun) { $arguments += '--dry-run' }
& $node.Source @arguments
exit $LASTEXITCODE
