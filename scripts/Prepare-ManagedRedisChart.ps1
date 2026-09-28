<#
.SYNOPSIS
Downloads, verifies, and patches the managed Redis Helm chart.
.PARAMETER Chart
OCI chart reference.
.PARAMETER Version
Exact Helm chart version.
.PARAMETER ArchiveSha256
Expected SHA-256 of the downloaded .tgz, including the sha256: prefix.
.PARAMETER Output
Directory that receives the verified and patched chart.
.PARAMETER Helm
Helm executable name or path.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Chart,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ArchiveSha256,
    [Parameter(Mandatory)][string]$Output,
    [string]$Helm = 'helm'
)

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or later is required but node was not found on PATH.' }
& $node.Source (Join-Path $PSScriptRoot 'prepare-managed-redis-chart.mjs') `
    --chart $Chart --version $Version --archive-sha256 $ArchiveSha256 --output $Output --helm $Helm
exit $LASTEXITCODE
