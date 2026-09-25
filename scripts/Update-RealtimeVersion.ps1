<#
.SYNOPSIS
    Updates the coordinated Cormier.Realtime version across active repository surfaces.
.DESCRIPTION
    Replaces the current coordinated version in tracked, nonhistorical text files, adds a
    new entry to each reference-application changelog, and creates a release-notes stub.
    Historical release notes, changelog entries, and files beneath refs are preserved.
    Use -WhatIf to inspect the complete file plan without writing anything.
.EXAMPLE
    ./scripts/Update-RealtimeVersion.ps1 -Version 1.0.3-beta -WhatIf
.EXAMPLE
    ./scripts/Update-RealtimeVersion.ps1 -Version 1.0.3-beta
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$PreviousVersion,

    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$ReleaseDate = [DateOnly]::FromDateTime([DateTime]::UtcNow).ToString('yyyy-MM-dd')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$propsPath = Join-Path $repositoryRoot 'Directory.Build.props'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-CoordinatedVersion {
    [xml]$props = Get-Content -LiteralPath $propsPath -Raw
    $properties = @(
        'ApplicationVersion',
        'ContainerVersion',
        'ContractsVersion',
        'RedisAdapterVersion',
        'AspNetCoreIntegrationVersion',
        'DotNetClientVersion',
        'BrowserPackageVersion',
        'HelmChartVersion'
    )
    $versions = foreach ($property in $properties) {
        $node = $props.SelectSingleNode("//${property}")
        if ($null -eq $node -or [string]::IsNullOrWhiteSpace($node.InnerText)) {
            throw "Directory.Build.props does not define ${property}."
        }
        $node.InnerText.Trim()
    }
    $unique = @($versions | Sort-Object -Unique)
    if ($unique.Count -ne 1) {
        throw "The coordinated properties must match before a version update: $($unique -join ', ')."
    }
    return $unique[0]
}

function Test-HistoricalPath {
    param([Parameter(Mandatory)][string]$Path)

    $normalized = $Path.Replace('\', '/')
    return $normalized.StartsWith('refs/', [StringComparison]::Ordinal) -or
        $normalized.StartsWith('docs/release-notes/', [StringComparison]::Ordinal) -or
        $normalized.EndsWith('/CHANGELOG.md', [StringComparison]::Ordinal)
}

function Get-TrackedMatches {
    param([Parameter(Mandatory)][string]$Value)

    $matches = @(& git -C $repositoryRoot grep -Il --fixed-strings -- $Value)
    if ($LASTEXITCODE -notin @(0, 1)) {
        throw "git grep failed while locating version '$Value'."
    }
    return @($matches | Where-Object { -not (Test-HistoricalPath $_) } | Sort-Object -Unique)
}

function Set-TextFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

$currentVersion = Get-CoordinatedVersion
if (-not [string]::IsNullOrWhiteSpace($PreviousVersion) -and
    -not [StringComparer]::Ordinal.Equals($PreviousVersion, $currentVersion)) {
    throw "PreviousVersion '$PreviousVersion' does not match the coordinated version '$currentVersion'."
}
if ([StringComparer]::Ordinal.Equals($Version, $currentVersion)) {
    throw "Version already equals '$Version'. Supply a new semantic version."
}

$releaseNotesRelativePath = "docs/release-notes/${Version}.md"
$releaseNotesPath = Join-Path $repositoryRoot $releaseNotesRelativePath
if (Test-Path -LiteralPath $releaseNotesPath) {
    throw "Release notes already exist at '$releaseNotesRelativePath'."
}

$versionFiles = @(Get-TrackedMatches $currentVersion)
if ($versionFiles.Count -eq 0) {
    throw "No active tracked files contain version '$currentVersion'."
}

$changelogFiles = @(& git -C $repositoryRoot ls-files 'examples/*/CHANGELOG.md')
if ($LASTEXITCODE -ne 0 -or $changelogFiles.Count -eq 0) {
    throw 'No tracked reference-application changelogs were found.'
}
$changelogUpdates = foreach ($relativePath in $changelogFiles) {
    $path = Join-Path $repositoryRoot $relativePath
    $content = [IO.File]::ReadAllText($path)
    if ($content -match "(?m)^## $([regex]::Escape($Version))(?:\s|$)") {
        throw "Changelog '$relativePath' already contains version '$Version'."
    }
    $firstEntry = [regex]::Match($content, '(?m)^##\s')
    if (-not $firstEntry.Success) {
        throw "Changelog '$relativePath' does not contain a version heading."
    }
    $entry = "## $Version - $ReleaseDate`n`n- See the coordinated release notes in ``docs/release-notes/$Version.md``.`n`n"
    [pscustomobject]@{
        RelativePath = $relativePath
        Path = $path
        Content = $content.Insert($firstEntry.Index, $entry)
    }
}

Write-Output "Coordinated version: $currentVersion -> $Version"
Write-Output "Active version files: $($versionFiles.Count)"
Write-Output "Reference changelogs: $($changelogFiles.Count)"
Write-Output "Release notes: $releaseNotesRelativePath"

foreach ($relativePath in $versionFiles) {
    $path = Join-Path $repositoryRoot $relativePath
    if ($PSCmdlet.ShouldProcess($relativePath, "Replace $currentVersion with $Version")) {
        $content = [IO.File]::ReadAllText($path)
        $updated = $content.Replace($currentVersion, $Version, [StringComparison]::Ordinal)
        if ([StringComparer]::Ordinal.Equals($content, $updated)) {
            throw "Expected version was not found in '$relativePath'."
        }
        Set-TextFile -Path $path -Content $updated
    }
}

foreach ($update in $changelogUpdates) {
    if ($PSCmdlet.ShouldProcess($update.RelativePath, "Add the $Version changelog entry")) {
        Set-TextFile -Path $update.Path -Content $update.Content
    }
}

$releaseNotes = @"
# Cormier Realtime $Version

This coordinated release updates the gateway application and container, Helm chart, .NET and browser packages, automation scripts, and reference applications to ``$Version``.

## Changes

- Describe operator-visible and consumer-visible changes before publication.

## Compatibility and upgrade notes

- Record protocol compatibility, breaking changes, deprecations, and required operator actions before publication.

## Release integrity

- Publication requires successful main-branch CI for the exact source commit.
- NuGet packages, the gateway image, and the public Helm chart use the same coordinated version.
"@
if ($PSCmdlet.ShouldProcess($releaseNotesRelativePath, 'Create release notes')) {
    Set-TextFile -Path $releaseNotesPath -Content ($releaseNotes.Replace("`r`n", "`n") + "`n")
}

if (-not $WhatIfPreference) {
    $remaining = @(Get-TrackedMatches $currentVersion)
    if ($remaining.Count -gt 0) {
        throw "The previous version remains in active tracked files: $($remaining -join ', ')."
    }

    $intent = & (Join-Path $PSScriptRoot 'Get-PackageReleaseIntent.ps1')
    if (-not [StringComparer]::Ordinal.Equals([string]$intent.Version, $Version)) {
        throw "Release intent reported '$($intent.Version)' instead of '$Version'."
    }
    Write-Output "Updated $($versionFiles.Count) active files, $($changelogFiles.Count) changelogs, and $releaseNotesRelativePath."
    Write-Output 'Next: edit the generated release notes and changelog summaries, regenerate/validate artifacts, and review the complete diff.'
}
