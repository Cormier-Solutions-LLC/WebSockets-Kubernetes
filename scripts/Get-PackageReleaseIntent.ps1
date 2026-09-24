<#
.SYNOPSIS
    Validates the coordinated package version and detects a release change.
.DESCRIPTION
    Reads the five NuGet versions and the npm version, requires one valid semantic version across all six,
    and optionally reads the candidate from and compares it with Git revisions. A release change is valid only when every package
    version changed together. The script returns one object and performs no registry or repository mutation.
#>
[CmdletBinding()]
param(
    [string]$CurrentRevision,
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

function Get-RevisionFile {
    param(
        [Parameter(Mandatory)]
        [string]$Revision,
        [Parameter(Mandatory)]
        [string]$Path
    )

    $text = (& git -C $RepositoryRoot show "${Revision}:${Path}") -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read ${Path} from revision ${Revision}."
    }
    return $text
}

$propsPath = Join-Path $RepositoryRoot 'Directory.Build.props'
$packageJsonPath = Join-Path $RepositoryRoot 'sdk/typescript/package.json'
$currentProps = if ([string]::IsNullOrWhiteSpace($CurrentRevision)) {
    Get-Content -LiteralPath $propsPath -Raw
} else {
    Get-RevisionFile -Revision $CurrentRevision -Path 'Directory.Build.props'
}
$currentPackage = if ([string]::IsNullOrWhiteSpace($CurrentRevision)) {
    Get-Content -LiteralPath $packageJsonPath -Raw
} else {
    Get-RevisionFile -Revision $CurrentRevision -Path 'sdk/typescript/package.json'
}
$current = Get-PackageVersions `
    -PropsText $currentProps `
    -PackageJsonText $currentPackage
$releaseVersion = Assert-CoordinatedVersion $current
$changed = @()

if (-not [string]::IsNullOrWhiteSpace($PreviousRevision)) {
    $previousProps = Get-RevisionFile -Revision $PreviousRevision -Path 'Directory.Build.props'
    $previousPackage = Get-RevisionFile -Revision $PreviousRevision -Path 'sdk/typescript/package.json'
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
