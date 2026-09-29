<#
.SYNOPSIS
  Runs the versioned Cormier.Realtime bootstrap and Kubernetes lifecycle contract.
.PARAMETER Action
  prerequisites, plan, bootstrap, backup, install, update, validate, rollback, recover, teardown, organize, or restore-layout.
.PARAMETER Config
  Path to the versioned JSON configuration. CORMIER_BOOTSTRAP_CONFIG is the shared environment-variable alternative.
.PARAMETER Topology
  Optional assertion that the configuration selects ha or non-ha. Profile is a compatibility alias.
.PARAMETER NameSuffix
  Optional DNS-label suffix used to derive the deployable instance naming contract.
.PARAMETER Manifest
  Organization manifest used by restore-layout.
.EXAMPLE
  ./scripts/Realtime-Bootstrap.ps1 -Action plan -Config ./.bootstrap/prod.json -Topology ha
.EXAMPLE
  ./scripts/Realtime-Bootstrap.ps1 -Action install -Config ./.bootstrap/prod.json -Topology ha -TimeoutSeconds 1200
.NOTES
  Run with -Action help for the shared command summary. Domains, origins, image and
  chart versions/digests, Kubernetes identities, storage and resource settings are
  supplied by Config. Passwords and the cert-manager Certificate are applied
  separately with Set-RealtimeRedisSecret.ps1 and Set-RealtimeCertificate.ps1.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Action,
    [string]$Config,
    [Alias('Profile')]
    [string]$Topology,
    [string]$NameSuffix,
    [string]$TimeoutSeconds = '300',
    [string]$Backup,
    [string]$Manifest,
    [switch]$DryRun,
    [switch]$ConfirmTopologyChange,
    [switch]$Force
)

$arguments = @((Join-Path $PSScriptRoot 'realtime-bootstrap.mjs'), $Action, '--timeout-seconds', [string]$TimeoutSeconds)
if ($Config) { $arguments += @('--config', $Config) }
if ($Topology) { $arguments += @('--profile', $Topology) }
if ($NameSuffix) { $arguments += @('--name-suffix', $NameSuffix) }
if ($Backup) { $arguments += @('--backup', $Backup) }
if ($Manifest) { $arguments += @('--manifest', $Manifest) }
if ($DryRun) { $arguments += '--dry-run' }
if ($ConfirmTopologyChange) { $arguments += '--confirm-topology-change' }
if ($Force) { $arguments += '--force' }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Write-Error 'Node.js 22 or later is required but node was not found on PATH.'
    exit 1
}
& $node.Source @arguments
$nodeExitCode = $LASTEXITCODE
if ($null -eq $nodeExitCode) { exit 1 }
exit $nodeExitCode
