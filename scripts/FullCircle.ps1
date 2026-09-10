<#
.SYNOPSIS
    Runs the Cormier.Realtime full-circle lifecycle through the shared cross-platform engine.
.PARAMETER Action
    plan, bootstrap, run, validate, cleanup, update, rollback, or recover.
.PARAMETER Profile
    Explicit non-ha or ha topology.
.PARAMETER DryRun
    Preview commands and changes without executing them.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('plan', 'bootstrap', 'run', 'validate', 'cleanup', 'update', 'rollback', 'recover')]
    [string]$Action,
    [Parameter(Mandatory)]
    [ValidateSet('non-ha', 'ha')]
    [string]$Profile,
    [switch]$DryRun
)

$arguments = @((Join-Path $PSScriptRoot 'full-circle.mjs'), $Action, '--profile', $Profile)
if ($DryRun) { $arguments += '--dry-run' }
& node @arguments
exit $LASTEXITCODE
