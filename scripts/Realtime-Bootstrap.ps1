<#
.SYNOPSIS
  Runs the versioned Cormier.Realtime bootstrap and Kubernetes lifecycle contract.
.PARAMETER Action
  prerequisites, plan, bootstrap, backup, install, update, validate, rollback, recover, or teardown.
.PARAMETER Config
  Path to the versioned JSON configuration. CORMIER_BOOTSTRAP_CONFIG is the shared environment-variable alternative.
.PARAMETER Topology
  Optional assertion that the configuration selects ha or non-ha. Profile is a compatibility alias.
.PARAMETER NameSuffix
  Optional DNS-label suffix used to derive the deployable instance naming contract.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Action,
    [string]$Config,
    [Alias('Profile')]
    [ValidateSet('ha', 'non-ha')][string]$Topology,
    [ValidatePattern('^(?=.{1,27}$)[a-z0-9]+(?:-[a-z0-9]+)*$')]
    [string]$NameSuffix,
    [ValidateRange(60, 1800)][int]$TimeoutSeconds = 300,
    [string]$Backup,
    [switch]$DryRun,
    [switch]$ConfirmTopologyChange,
    [switch]$Force
)

$arguments = @((Join-Path $PSScriptRoot 'realtime-bootstrap.mjs'), $Action, '--timeout-seconds', [string]$TimeoutSeconds)
if ($Config) { $arguments += @('--config', $Config) }
if ($Topology) { $arguments += @('--profile', $Topology) }
if ($NameSuffix) { $arguments += @('--name-suffix', $NameSuffix) }
if ($Backup) { $arguments += @('--backup', $Backup) }
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
