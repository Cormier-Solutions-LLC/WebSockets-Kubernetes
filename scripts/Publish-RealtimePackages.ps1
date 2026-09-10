<#
.SYNOPSIS
    Verifies and publishes one previously built immutable Cormier.Realtime package candidate.
.DESCRIPTION
    Never rebuilds package bytes. NuGet is the default promotion surface; npm publication is opt-in and requires
    explicit registry approval. WhatIf validates and prints the promotion plan without requiring credentials.
.NOTES
    Version: 1.0.0
    Project: Cormier.Realtime
    Requires: PowerShell 7, .NET SDK 10, Node.js/npm only when PublishNpm is selected.
    Inputs: CandidatePath, configured registry endpoints, and secret-backed environment variables.
    Outputs: Redacted promotion log and state in the configured EvidencePath.
    Exit codes: 0 success; 1 publication failure; 2 invalid candidate/input; 3 prerequisite failure; 4 credential failure.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [string]$CandidatePath,
    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$NuGetSource,
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')]
    [string]$NuGetApiKeyEnvironmentName = 'NUGET_API_KEY',
    [switch]$PublishNpm,
    [ValidatePattern('^https://')]
    [string]$NpmRegistry,
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')]
    [string]$NpmTokenEnvironmentName = 'NPM_TOKEN',
    [string]$EvidencePath = 'artifacts/package-promotion',
    [ValidateRange(30, 1800)]
    [int]$CommandTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$logDirectory = Join-Path $repositoryRoot '.logs'
$logPath = Join-Path $logDirectory "package-publish-$timestamp.log"
$temporaryNpmConfig = $null
$temporaryNpmDirectory = $null
$phase = 'Initialize'
$scriptExitCode = 0

function Write-PromotionLog {
    param(
        [ValidateSet('INFO', 'PASS', 'WARN', 'ERROR')]
        [string]$Level,
        [string]$Message
    )
    $safe = $Message -replace '(?i)(authorization|password|token|secret|cookie|apikey)\s*[=:]\s*\S+', '$1=[REDACTED]'
    $line = '[{0}] [{1}] [{2}] {3}' -f [DateTimeOffset]::UtcNow.ToString('u'), $Level, $phase, $safe
    Write-Output $line
    if (Test-Path -LiteralPath $logDirectory) {
        Add-Content -LiteralPath $logPath -Value $line -Encoding utf8NoBOM
    }
}

function Get-RequiredApplication {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        throw "MISSING prerequisite: $Name"
    }
    return $command.Source
}

function Invoke-PromotionTool {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [hashtable]$Environment = @{}
    )
    Write-PromotionLog INFO ("Running {0}." -f [IO.Path]::GetFileName($FilePath))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.WorkingDirectory = $candidateRoot
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) {
        $start.ArgumentList.Add($argument)
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $start.Environment[$entry.Key] = [string]$entry.Value
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Unable to start $FilePath." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($CommandTimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw "Publication command exceeded the configured $CommandTimeoutSeconds second timeout."
        }
        $output = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
        $safeOutput = $output -replace '(?i)(authorization|password|token|secret|cookie|apikey)\s*[=:]\s*\S+', '$1=[REDACTED]'
        if (-not [string]::IsNullOrWhiteSpace($safeOutput)) {
            Add-Content -LiteralPath $logPath -Value $safeOutput -Encoding utf8NoBOM
        }
        if ($process.ExitCode -ne 0) {
            throw "Publication command failed with exit code $($process.ExitCode). Duplicate versions are not skipped because remote byte identity was not proven."
        }
    }
    finally {
        $process.Dispose()
    }
}

try {
    $candidateRoot = (Resolve-Path -LiteralPath $CandidatePath -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) {
        throw "INVALID candidate directory: $CandidatePath"
    }
    $manifestPath = Join-Path $candidateRoot 'manifest.json'
    $checksumsPath = Join-Path $candidateRoot 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $checksumsPath -PathType Leaf)) {
        throw 'INVALID candidate: manifest.json and SHA256SUMS are required.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.publishable -or
        $manifest.sourceTree -ne 'clean' -or $manifest.sourceCommit -notmatch '^[0-9a-f]{40}$') {
        throw 'INVALID candidate: schema version is unsupported or the candidate records skipped tests.'
    }
    if ((Split-Path -Leaf $candidateRoot) -ne $manifest.sourceCommit) {
        throw 'INVALID candidate: directory name must equal the manifest source commit.'
    }
    if ($PublishNpm -and [string]::IsNullOrWhiteSpace($NpmRegistry)) {
        throw 'INVALID input: NpmRegistry is required when PublishNpm is selected.'
    }

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $phase = 'Verify candidate'
    $expectedChecksums = [ordered]@{}
    foreach ($artifact in $manifest.artifacts) {
        if ($artifact.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$' -or
            $artifact.sha256 -notmatch '^[a-f0-9]{64}$' -or
            $expectedChecksums.Contains($artifact.name)) {
            throw "INVALID candidate: unsafe or duplicate artifact entry $($artifact.name)."
        }
        $artifactPath = Join-Path $candidateRoot $artifact.name
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "INVALID candidate: missing artifact $($artifact.name)."
        }
        $actual = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $artifact.sha256) {
            throw "INVALID candidate: SHA-256 mismatch for $($artifact.name)."
        }
        $expectedChecksums[$artifact.name] = $artifact.sha256
    }
    $recordedChecksums = [ordered]@{}
    foreach ($line in Get-Content -LiteralPath $checksumsPath) {
        if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$' -or
            $recordedChecksums.Contains($Matches[2])) {
            throw 'INVALID candidate: SHA256SUMS contains an invalid or duplicate entry.'
        }
        $recordedChecksums[$Matches[2]] = $Matches[1]
    }
    if ($recordedChecksums.Count -ne $expectedChecksums.Count) {
        throw 'INVALID candidate: SHA256SUMS does not describe the complete artifact inventory.'
    }
    foreach ($name in $expectedChecksums.Keys) {
        if (-not $recordedChecksums.Contains($name) -or $recordedChecksums[$name] -ne $expectedChecksums[$name]) {
            throw "INVALID candidate: SHA256SUMS disagrees with manifest.json for $name."
        }
    }
    Write-PromotionLog PASS "Verified $($manifest.artifacts.Count) immutable artifacts from commit $($manifest.sourceCommit)."

    $dotnet = Get-RequiredApplication dotnet
    if ($PublishNpm) { $npm = Get-RequiredApplication npm }
    $resolvedEvidence = if ([IO.Path]::IsPathRooted($EvidencePath)) {
        [IO.Path]::GetFullPath($EvidencePath)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
    }
    if ([IO.Path]::GetPathRoot($resolvedEvidence) -eq $resolvedEvidence) {
        throw "INVALID input: EvidencePath cannot be a filesystem root: $resolvedEvidence"
    }

    $nugetPackages = @(Get-ChildItem -LiteralPath $candidateRoot -Filter '*.nupkg' -File |
        Where-Object { $_.Extension -eq '.nupkg' } | Sort-Object Name)
    if ($nugetPackages.Count -ne 5) {
        throw "INVALID candidate: expected five NuGet packages, found $($nugetPackages.Count)."
    }
    $npmPackages = @(Get-ChildItem -LiteralPath $candidateRoot -Filter '*.tgz' -File)
    if ($npmPackages.Count -ne 1) {
        throw "INVALID candidate: expected one npm tarball, found $($npmPackages.Count)."
    }

    $phase = 'Promotion plan'
    if (-not $PSCmdlet.ShouldProcess($NuGetSource, "Publish $($nugetPackages.Count) immutable NuGet packages")) {
        foreach ($package in $nugetPackages) {
            Write-PromotionLog INFO "WHATIF: would publish $($package.Name) to the configured NuGet source."
        }
        if ($PublishNpm) {
            Write-PromotionLog INFO "WHATIF: would publish $($npmPackages[0].Name) to the configured npm registry."
        }
        Write-PromotionLog PASS 'WHATIF: candidate verified and publication commands rehearsed without credentials or registry mutation.'
        return
    }

    $nugetApiKey = [Environment]::GetEnvironmentVariable($NuGetApiKeyEnvironmentName)
    if ([string]::IsNullOrWhiteSpace($nugetApiKey)) {
        throw "UNAUTHORIZED: environment variable $NuGetApiKeyEnvironmentName is required."
    }
    New-Item -ItemType Directory -Path $resolvedEvidence -Force | Out-Null
    $statePath = Join-Path $resolvedEvidence ("promotion-$($manifest.sourceCommit).json")
    $manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $completed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if (Test-Path -LiteralPath $statePath) {
        $prior = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($prior.sourceCommit -ne $manifest.sourceCommit -or $prior.nugetSource -ne $NuGetSource -or
            $prior.manifestSha256 -ne $manifestSha256) {
            throw 'Existing promotion state belongs to a different candidate or registry.'
        }
        $priorCompleted = @($prior.completed | ForEach-Object { [string]$_ })
        $priorNpmCompleted = @($priorCompleted | Where-Object { $_ -like '*.tgz' })
        if ($PublishNpm -and $priorNpmCompleted.Count -gt 0 -and $prior.npmRegistry -ne $NpmRegistry) {
            throw 'Existing npm promotion state belongs to a different registry.'
        }
        $candidateArtifactNames = @($manifest.artifacts | ForEach-Object { [string]$_.name })
        foreach ($name in $priorCompleted) {
            if ($name -notin $candidateArtifactNames -or $name -notmatch '\.(?:nupkg|tgz)$') {
                throw "Existing promotion state contains an unknown artifact: $name"
            }
            [void]$completed.Add($name)
        }
    }

    $phase = 'Publish NuGet'
    foreach ($package in $nugetPackages) {
        if ($completed.Contains($package.Name)) {
            Write-PromotionLog PASS "UNCHANGED: prior verified promotion state records $($package.Name)."
            continue
        }
        Invoke-PromotionTool $dotnet @('nuget', 'push', $package.FullName, '--source', $NuGetSource, '--api-key', $nugetApiKey, '--timeout', [string]$CommandTimeoutSeconds)
        [void]$completed.Add($package.Name)
        [ordered]@{
            schemaVersion = 1
            sourceCommit = $manifest.sourceCommit
            manifestSha256 = $manifestSha256
            nugetSource = $NuGetSource
            npmRegistry = if ($PublishNpm) { $NpmRegistry } else { $null }
            completed = @($completed | Sort-Object)
            updatedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8NoBOM
    }

    if ($PublishNpm -and -not $completed.Contains($npmPackages[0].Name)) {
        $phase = 'Publish npm'
        $npmToken = [Environment]::GetEnvironmentVariable($NpmTokenEnvironmentName)
        if ([string]::IsNullOrWhiteSpace($npmToken)) {
            throw "UNAUTHORIZED: environment variable $NpmTokenEnvironmentName is required."
        }
        $registryUri = [Uri]$NpmRegistry
        $temporaryNpmDirectory = Join-Path ([IO.Path]::GetTempPath()) ("cormier-npm-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $temporaryNpmDirectory -ErrorAction Stop | Out-Null
        if (-not $IsWindows) {
            [IO.File]::SetUnixFileMode(
                $temporaryNpmDirectory,
                [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute)
        }
        $temporaryNpmConfig = Join-Path $temporaryNpmDirectory '.npmrc'
        ("//{0}{1}/:_authToken={2}" -f $registryUri.Authority, $registryUri.AbsolutePath.TrimEnd('/'), $npmToken) |
            Set-Content -LiteralPath $temporaryNpmConfig -Encoding utf8NoBOM
        if (-not $IsWindows) {
            [IO.File]::SetUnixFileMode(
                $temporaryNpmConfig,
                [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite)
        }
        Invoke-PromotionTool $npm @('publish', $npmPackages[0].FullName, '--registry', $NpmRegistry) `
            -Environment @{ NPM_CONFIG_USERCONFIG = $temporaryNpmConfig }
        [void]$completed.Add($npmPackages[0].Name)
        [ordered]@{
            schemaVersion = 1
            sourceCommit = $manifest.sourceCommit
            manifestSha256 = $manifestSha256
            nugetSource = $NuGetSource
            npmRegistry = $NpmRegistry
            completed = @($completed | Sort-Object)
            updatedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8NoBOM
    }
    Write-PromotionLog PASS "SUMMARY: promoted $($completed.Count) immutable artifacts; evidence=$statePath; log=$logPath"
}
catch {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    Write-PromotionLog ERROR $_.Exception.Message
    $scriptExitCode = if ($_.Exception.Message -like 'INVALID*') { 2 }
        elseif ($_.Exception.Message -like 'MISSING*') { 3 }
        elseif ($_.Exception.Message -like 'UNAUTHORIZED*') { 4 }
        else { 1 }
}
finally {
    if ($null -ne $temporaryNpmDirectory -and (Test-Path -LiteralPath $temporaryNpmDirectory)) {
        $resolvedNpmDirectory = (Resolve-Path -LiteralPath $temporaryNpmDirectory).Path
        $resolvedTemp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
        if (-not $resolvedNpmDirectory.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove npm credential directory outside the configured temporary directory: $resolvedNpmDirectory"
        }
        Remove-Item -LiteralPath $resolvedNpmDirectory -Recurse -Force
    }
}
if ($scriptExitCode -ne 0) {
    exit $scriptExitCode
}
