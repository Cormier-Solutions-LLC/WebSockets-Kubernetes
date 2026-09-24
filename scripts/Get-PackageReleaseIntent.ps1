<#
.SYNOPSIS
    Validates the coordinated package version and detects a release change.
.DESCRIPTION
    Reads the five NuGet versions and the npm version, requires one valid semantic version across all six,
    and optionally compares them with a Git revision. A release change is valid only when every package
    version changed together. The script returns one object and performs no registry or repository mutation.
#>
[CmdletBinding()]
param(
    [string]$PreviousRevision,
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PackageVersions {
    param(
        [Parameter(Mandatory)]
        [string]$PropsText,
        [Parameter(Mandatory)]
        [string]$PackageJsonText
    )

    [xml]$props = $PropsText
    $package = $PackageJsonText | ConvertFrom-Json
    $versions = [ordered]@{}
    foreach ($name in @(
        'ContractsVersion',
        'DotNetClientVersion',
        'RedisAdapterVersion',
        'AspNetCoreIntegrationVersion',
        'BrowserPackageVersion'
    )) {
        $node = $props.SelectSingleNode("//${name}")
        if ($null -eq $node -or [string]::IsNullOrWhiteSpace($node.InnerText)) {
            throw "Directory.Build.props does not define ${name}."
        }
        $versions[$name] = $node.InnerText.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($package.version)) {
        throw 'sdk/typescript/package.json does not define version.'
    }
    $versions['NpmVersion'] = $package.version.Trim()
    return $versions
}

function Assert-CoordinatedVersion {
    param(
        [Parameter(Mandatory)]
        [Collections.IDictionary]$Versions
    )

    $unique = @($Versions.Values | Sort-Object -Unique)
    if ($unique.Count -ne 1) {
        $detail = ($Versions.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
        throw "Every coordinated NuGet and npm package version must match: ${detail}"
    }
    if ($unique[0] -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
        throw "Package version '$($unique[0])' is not valid semantic versioning."
    }
    return [string]$unique[0]
}

$propsPath = Join-Path $RepositoryRoot 'Directory.Build.props'
$packageJsonPath = Join-Path $RepositoryRoot 'sdk/typescript/package.json'
$current = Get-PackageVersions `
    -PropsText (Get-Content -LiteralPath $propsPath -Raw) `
    -PackageJsonText (Get-Content -LiteralPath $packageJsonPath -Raw)
$releaseVersion = Assert-CoordinatedVersion $current
$changed = @()

if (-not [string]::IsNullOrWhiteSpace($PreviousRevision)) {
    $previousProps = (& git -C $RepositoryRoot show "${PreviousRevision}:Directory.Build.props") -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read Directory.Build.props from revision ${PreviousRevision}."
    }
    $previousPackage = (& git -C $RepositoryRoot show "${PreviousRevision}:sdk/typescript/package.json") -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read sdk/typescript/package.json from revision ${PreviousRevision}."
    }
    $previous = Get-PackageVersions -PropsText $previousProps -PackageJsonText $previousPackage
    $changed = @($current.Keys | Where-Object { $current[$_] -ne $previous[$_] })
    if ($changed.Count -gt 0 -and $changed.Count -ne $current.Count) {
        throw "A coordinated release must change every package version; changed: $($changed -join ', ')."
    }
}

[pscustomobject]@{
    Version = $releaseVersion
    VersionChanged = $changed.Count -eq $current.Count
    ChangedPackages = $changed
}
