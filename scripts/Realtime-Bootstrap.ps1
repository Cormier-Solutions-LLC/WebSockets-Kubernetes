<#
.SYNOPSIS
  Runs the versioned Cormier.Realtime bootstrap and Kubernetes lifecycle contract.
.PARAMETER Action
  prerequisites, plan, bootstrap, backup, install, update, validate, rollback, recover, or teardown.
.PARAMETER Config
  Path to the versioned JSON configuration. CORMIER_BOOTSTRAP_CONFIG is the shared environment-variable alternative.
.PARAMETER Topology
  Optional assertion that the configuration selects ha or non-ha. Profile is a compatibility alias.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('prerequisites', 'plan', 'bootstrap', 'backup', 'install', 'update', 'validate', 'rollback', 'recover', 'teardown')]
    [string]$Action,
    [string]$Config,
    [Alias('Profile')]
    [ValidateSet('ha', 'non-ha')][string]$Topology,
    [ValidateRange(60, 1800)][int]$TimeoutSeconds = 300,
    [string]$Backup,
    [switch]$DryRun,
    [switch]$ConfirmTopologyChange,
    [switch]$Force
)

$arguments = @((Join-Path $PSScriptRoot 'realtime-bootstrap.mjs'), $Action, '--timeout-seconds', [string]$TimeoutSeconds)
if ($Config) { $arguments += @('--config', $Config) }
if ($Topology) { $arguments += @('--profile', $Topology) }
if ($Backup) { $arguments += @('--backup', $Backup) }
if ($DryRun) { $arguments += '--dry-run' }
if ($ConfirmTopologyChange) { $arguments += '--confirm-topology-change' }
if ($Force) { $arguments += '--force' }
& node @arguments
exit $LASTEXITCODE
