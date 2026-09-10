<#
.SYNOPSIS
    Builds, tests, packs, inspects, and records one immutable Cormier.Realtime package candidate.
.DESCRIPTION
    Uses isolated staging and promotes only byte-identical repeatable artifacts. Network endpoints are explicit
    configuration. WhatIf prints the plan without invoking build tools or changing output.
.NOTES
    Version: 1.0.0
    Project: Cormier.Realtime
    Requires: PowerShell 7, .NET SDK 10, Node.js 22 or later, npm, and Git.
    Outputs: artifacts/packages/<commit> by default and a redacted log beneath .logs.
    Exit codes: 0 success; 1 build/validation failure; 2 invalid input; 3 missing prerequisite.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$ContractsVersion = '0.1.0',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$DotNetClientVersion = '0.1.0',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$RedisAdapterVersion = '0.1.0',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$AspNetCoreIntegrationVersion = '0.1.0',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$BrowserPackageVersion = '0.1.0',
    [string]$UpstreamPackageSource = $env:NUGET_UPSTREAM_SOURCE,
    [string]$RedisTestEndpoint = $env:REDIS_TEST_ENDPOINT,
    [string]$OutputPath = 'artifacts/packages',
    [ValidateRange(60, 7200)]
    [int]$CommandTimeoutSeconds = 1800,
    [switch]$SkipIntegrationTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$logDirectory = Join-Path $repositoryRoot '.logs'
$logPath = Join-Path $logDirectory "package-build-$timestamp.log"
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cormier-realtime-packages-" + [guid]::NewGuid().ToString('N'))
$phase = 'Initialize'
$scriptExitCode = 0

function Write-ReleaseLog {
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

function Get-RequiredCommand {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        throw "MISSING prerequisite: $Name"
    }
    return $command.Source
}

function Invoke-ReleaseTool {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory = $repositoryRoot,
        [hashtable]$Environment = @{}
    )
    Write-ReleaseLog INFO ("Running {0} in {1}" -f [IO.Path]::GetFileName($FilePath), $WorkingDirectory)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.WorkingDirectory = $WorkingDirectory
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
        if (-not $process.Start()) {
            throw "Unable to start $FilePath."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($CommandTimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw "Command exceeded the configured $CommandTimeoutSeconds second timeout."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        foreach ($text in @($stdout, $stderr)) {
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                $safeText = $text -replace '(?i)(authorization|password|token|secret|cookie|apikey)\s*[=:]\s*\S+', '$1=[REDACTED]'
                Add-Content -LiteralPath $logPath -Value $safeText -Encoding utf8NoBOM
            }
        }
        if ($process.ExitCode -ne 0) {
            throw "Command failed with exit code $($process.ExitCode). See $logPath."
        }
    }
    finally {
        $process.Dispose()
    }
}

function Get-ArtifactInventory {
    param([string]$Path)
    return @(Get-ChildItem -LiteralPath $Path -File | Sort-Object Name | ForEach-Object {
        [ordered]@{
            name = $_.Name
            length = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
}

function Assert-Reproducible {
    param([string]$First, [string]$Second)
    $leftInventory = @(Get-ArtifactInventory $First)
    $rightInventory = @(Get-ArtifactInventory $Second)
    $left = $leftInventory | ConvertTo-Json -Depth 5 -Compress
    $right = $rightInventory | ConvertTo-Json -Depth 5 -Compress
    if ($left -ne $right) {
        $rightByName = @{}
        foreach ($artifact in $rightInventory) { $rightByName[$artifact.name] = $artifact }
        foreach ($artifact in $leftInventory) {
            $other = $rightByName[$artifact.name]
            if ($null -eq $other -or $artifact.sha256 -ne $other.sha256) {
                Write-ReleaseLog ERROR ("Reproducibility mismatch: {0}; first={1}; second={2}" -f $artifact.name, $artifact.sha256, $other.sha256)
            }
        }
        throw 'The two isolated pack runs produced different artifact names, sizes, or SHA-256 hashes.'
    }
}

function ConvertTo-DeterministicPackage {
    param([string]$PackagePath)
    $resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
    $temporaryPackage = "$resolvedPackage.deterministic"
    $source = [IO.Compression.ZipFile]::OpenRead($resolvedPackage)
    try {
        $coreEntries = @($source.Entries | Where-Object {
            $_.FullName -like 'package/services/metadata/core-properties/*.psmdcp'
        })
        if ($coreEntries.Count -ne 1) {
            throw "Package $resolvedPackage does not contain exactly one core-properties entry."
        }
        $coreEntry = $coreEntries[0]
        $originalCorePath = $coreEntry.FullName
        $fixedCorePath = 'package/services/metadata/core-properties/package.psmdcp'
        $content = @{}
        foreach ($entry in $source.Entries) {
            $stream = $entry.Open()
            try {
                $memory = [IO.MemoryStream]::new()
                try {
                    $stream.CopyTo($memory)
                    $bytes = $memory.ToArray()
                }
                finally {
                    $memory.Dispose()
                }
            }
            finally {
                $stream.Dispose()
            }
            $name = if ($entry.FullName -eq $originalCorePath) { $fixedCorePath } else { $entry.FullName }
            if ($entry.FullName -in @('_rels/.rels', '[Content_Types].xml')) {
                $text = [Text.Encoding]::UTF8.GetString($bytes).Replace($originalCorePath, $fixedCorePath)
                if ($entry.FullName -eq '_rels/.rels') {
                    $text = $text -replace '(metadata/core-properties" Target="/package/services/metadata/core-properties/package\.psmdcp" Id=")[^"]+', '${1}RCOREPROPERTIES'
                }
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            }
            elseif ($entry.FullName -in @(
                'build/Microsoft.AspNetCore.StaticWebAssets.props',
                'build/Microsoft.AspNetCore.StaticWebAssetEndpoints.props'
            )) {
                $text = [Text.Encoding]::UTF8.GetString($bytes)
                $text = $text -replace '<LastWriteTime>[^<]+</LastWriteTime>', '<LastWriteTime>Tue, 01 Jan 1980 00:00:00 GMT</LastWriteTime>'
                $text = $text -replace '("Name":"Last-Modified","Value":")[^"]+', '${1}Tue, 01 Jan 1980 00:00:00 GMT'
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            }
            $content[$name] = $bytes
        }
    }
    finally {
        $source.Dispose()
    }

    $target = [IO.Compression.ZipFile]::Open($temporaryPackage, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @($content.Keys | Sort-Object)) {
            $entry = $target.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $stream = $entry.Open()
            try {
                $bytes = $content[$name]
                $stream.Write($bytes, 0, $bytes.Length)
            }
            finally {
                $stream.Dispose()
            }
        }
    }
    finally {
        $target.Dispose()
    }
    Move-Item -LiteralPath $temporaryPackage -Destination $resolvedPackage -Force
}

function Assert-NuGetPackage {
    param(
        [string]$Path,
        [string[]]$RequiredEntries,
        [string[]]$RequiredNuspecText
    )
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries | ForEach-Object FullName)
        foreach ($required in $RequiredEntries) {
            if ($required -notin $entries) {
                throw "Package $([IO.Path]::GetFileName($Path)) is missing intended asset $required."
            }
        }
        if ($entries | Where-Object { $_ -match '(^|/)(bin|obj)/|appsettings|\.deps\.json$|\.runtimeconfig\.json$' }) {
            throw "Package $([IO.Path]::GetFileName($Path)) contains an unintended build or application asset."
        }
        $nuspecEntry = $archive.Entries | Where-Object FullName -like '*.nuspec' | Select-Object -First 1
        if ($null -eq $nuspecEntry) { throw "Package $Path has no nuspec." }
        $reader = [IO.StreamReader]::new($nuspecEntry.Open())
        try { $nuspec = $reader.ReadToEnd() } finally { $reader.Dispose() }
        foreach ($requiredText in $RequiredNuspecText) {
            if (-not $nuspec.Contains($requiredText, [StringComparison]::Ordinal)) {
                throw "Package $([IO.Path]::GetFileName($Path)) metadata is missing: $requiredText"
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Assert-CandidateEvidence {
    param(
        [string]$Path,
        [System.Collections.IDictionary]$ExpectedManifest,
        [object[]]$ExpectedInventory
    )
    $manifestPath = Join-Path $Path 'manifest.json'
    $checksumsPath = Join-Path $Path 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $checksumsPath -PathType Leaf)) {
        throw "Version conflict: existing candidate $Path is missing its evidence files."
    }
    $existingManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($existingManifest.schemaVersion -ne $ExpectedManifest.schemaVersion -or
        $existingManifest.sourceCommit -ne $ExpectedManifest.sourceCommit -or
        $existingManifest.publishable -ne $ExpectedManifest.publishable -or
        $existingManifest.sourceTree -ne $ExpectedManifest.sourceTree -or
        $existingManifest.protocolVersion -ne $ExpectedManifest.protocolVersion -or
        ($existingManifest.versions | ConvertTo-Json -Compress) -ne ($ExpectedManifest.versions | ConvertTo-Json -Compress) -or
        ($existingManifest.artifacts | ConvertTo-Json -Depth 5 -Compress) -ne ($ExpectedInventory | ConvertTo-Json -Depth 5 -Compress)) {
        throw "Version conflict: existing candidate $Path has stale or inconsistent manifest evidence."
    }
    $expectedChecksumLines = @($ExpectedInventory | ForEach-Object { '{0}  {1}' -f $_.sha256, $_.name })
    $existingChecksumLines = @(Get-Content -LiteralPath $checksumsPath)
    if (Compare-Object $expectedChecksumLines $existingChecksumLines) {
        throw "Version conflict: existing candidate $Path has stale or inconsistent checksum evidence."
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($UpstreamPackageSource)) {
        throw 'INVALID input: UpstreamPackageSource or NUGET_UPSTREAM_SOURCE is required.'
    }
    if (-not $SkipIntegrationTests -and [string]::IsNullOrWhiteSpace($RedisTestEndpoint)) {
        throw 'INVALID input: RedisTestEndpoint or REDIS_TEST_ENDPOINT is required unless SkipIntegrationTests is explicitly selected.'
    }
    $packageJson = Get-Content -LiteralPath (Join-Path $repositoryRoot 'sdk/typescript/package.json') -Raw | ConvertFrom-Json
    $normalizedBrowserVersion = ($BrowserPackageVersion -split '\+', 2)[0]
    $normalizedContractsVersion = ($ContractsVersion -split '\+', 2)[0]
    $contractsCore = [version](($ContractsVersion -split '[-+]', 2)[0])
    $ContractsCompatibilityUpperBound = '{0}.{1}.0' -f $contractsCore.Major, ($contractsCore.Minor + 1)
    $normalizedRedisVersion = ($RedisAdapterVersion -split '\+', 2)[0]
    $redisCore = [version](($RedisAdapterVersion -split '[-+]', 2)[0])
    $RedisAdapterCompatibilityUpperBound = '{0}.{1}.0' -f $redisCore.Major, ($redisCore.Minor + 1)
    if ($packageJson.version -ne $normalizedBrowserVersion) {
        throw "INVALID input: BrowserPackageVersion $BrowserPackageVersion does not match sdk/typescript/package.json version $($packageJson.version)."
    }
    $resolvedOutput = if ([IO.Path]::IsPathRooted($OutputPath)) {
        [IO.Path]::GetFullPath($OutputPath)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
    }
    if ([IO.Path]::GetPathRoot($resolvedOutput) -eq $resolvedOutput) {
        throw "INVALID input: OutputPath cannot be a filesystem root: $resolvedOutput"
    }
    if (-not $PSCmdlet.ShouldProcess($resolvedOutput, 'Build and verify immutable package candidate')) {
        Write-Output "WHATIF: would build, test, reproducibility-check, and stage packages beneath $resolvedOutput"
        return
    }

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $phase = 'Prerequisites'
    $dotnet = Get-RequiredCommand dotnet
    $node = Get-RequiredCommand node
    $npm = Get-RequiredCommand npm
    $git = Get-RequiredCommand git
    $pwsh = Get-RequiredCommand pwsh
    Invoke-ReleaseTool $dotnet @('--version')
    Invoke-ReleaseTool $node @('--version')
    Invoke-ReleaseTool $npm @('--version')
    $commit = (& $git -C $repositoryRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
        throw 'UNUSABLE prerequisite: unable to resolve the source commit.'
    }
    $sourceDirty = -not [string]::IsNullOrWhiteSpace(((& $git -C $repositoryRoot status --porcelain --untracked-files=all) -join "`n"))
    if ($sourceDirty -and -not $SkipIntegrationTests) {
        throw 'INVALID source: a publishable candidate requires a clean Git worktree.'
    }
    Write-ReleaseLog PASS "Prerequisites ready; source commit $commit."

    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    $firstPack = Join-Path $stageRoot 'pack-a'
    $secondPack = Join-Path $stageRoot 'pack-b'
    New-Item -ItemType Directory -Path $firstPack, $secondPack -Force | Out-Null
    $properties = @(
        "-p:ContractsVersion=$ContractsVersion",
        "-p:DotNetClientVersion=$DotNetClientVersion",
        "-p:RedisAdapterVersion=$RedisAdapterVersion",
        "-p:AspNetCoreIntegrationVersion=$AspNetCoreIntegrationVersion",
        "-p:BrowserPackageVersion=$BrowserPackageVersion"
    )

    $phase = 'Restore and build'
    Invoke-ReleaseTool $npm @('ci') (Join-Path $repositoryRoot 'sdk/typescript')
    Invoke-ReleaseTool $npm @('run', 'check') (Join-Path $repositoryRoot 'sdk/typescript')
    Invoke-ReleaseTool $dotnet (@('restore', 'Cormier.Realtime.sln', '--runtime', 'linux-x64', '--locked-mode') + $properties)
    Invoke-ReleaseTool $dotnet (@('build', 'Cormier.Realtime.sln', '--configuration', 'Release', '--no-restore') + $properties)

    $phase = 'Test'
    if ($SkipIntegrationTests) {
        Write-ReleaseLog WARN 'Integration tests were explicitly skipped; this candidate is not publishable.'
        foreach ($project in @(
            'tests/Cormier.Realtime.Client.Tests/Cormier.Realtime.Client.Tests.csproj',
            'tests/Cormier.Realtime.UnitTests/Cormier.Realtime.UnitTests.csproj',
            'tests/Cormier.Realtime.KubernetesTests/Cormier.Realtime.KubernetesTests.csproj',
            'tests/Cormier.Realtime.LoadTests/Cormier.Realtime.LoadTests.csproj'
        )) {
            Invoke-ReleaseTool $dotnet @('test', $project, '--configuration', 'Release', '--no-build', '--no-restore', '--logger', 'trx', '--results-directory', 'artifacts/package-test-results')
        }
    }
    else {
        Invoke-ReleaseTool $dotnet @('test', 'Cormier.Realtime.sln', '--configuration', 'Release', '--no-build', '--no-restore', '--logger', 'trx', '--results-directory', 'artifacts/package-test-results') `
            -Environment @{ REDIS_TEST_ENDPOINT = $RedisTestEndpoint }
    }

    $phase = 'Pack and inspect'
    $projects = @(
        'src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj',
        'src/Cormier.Realtime.Client/Cormier.Realtime.Client.csproj',
        'src/Cormier.Realtime.Redis/Cormier.Realtime.Redis.csproj',
        'src/Cormier.Realtime.AspNetCore/Cormier.Realtime.AspNetCore.csproj',
        'src/Cormier.Realtime.Browser/Cormier.Realtime.Browser.csproj'
    )
    foreach ($destination in @($firstPack, $secondPack)) {
        foreach ($project in $projects) {
            Invoke-ReleaseTool $dotnet (@('pack', $project, '--configuration', 'Release', '--no-build', '--no-restore', '--output', $destination) + $properties)
        }
        Get-ChildItem -LiteralPath $destination -File | Where-Object {
            $_.Extension -in @('.nupkg', '.snupkg')
        } | ForEach-Object {
            ConvertTo-DeterministicPackage $_.FullName
        }
        Invoke-ReleaseTool $npm @('pack', '--json', '--pack-destination', $destination) (Join-Path $repositoryRoot 'sdk/typescript')
    }
    Assert-Reproducible $firstPack $secondPack
    $metadata = @('<license type="expression">MIT</license>', '<readme>README.md</readme>', '<repository type="git"')
    Assert-NuGetPackage (Join-Path $firstPack "Cormier.Realtime.Contracts.$(($ContractsVersion -split '\+', 2)[0]).nupkg") `
        @('README.md', 'lib/netstandard2.0/Cormier.Realtime.Contracts.dll', 'lib/net10.0/Cormier.Realtime.Contracts.dll') $metadata
    Assert-NuGetPackage (Join-Path $firstPack "Cormier.Realtime.Client.$(($DotNetClientVersion -split '\+', 2)[0]).nupkg") `
        @('README.md', 'lib/netstandard2.0/Cormier.Realtime.Client.dll') `
        ($metadata + ('<dependency id="Cormier.Realtime.Contracts" version="[{0}, {1})"' -f $normalizedContractsVersion, $ContractsCompatibilityUpperBound))
    Assert-NuGetPackage (Join-Path $firstPack "Cormier.Realtime.Redis.$(($RedisAdapterVersion -split '\+', 2)[0]).nupkg") `
        @('README.md', 'lib/net10.0/Cormier.Realtime.Redis.dll') `
        ($metadata + ('<dependency id="Cormier.Realtime.Contracts" version="[{0}, {1})"' -f $normalizedContractsVersion, $ContractsCompatibilityUpperBound))
    Assert-NuGetPackage (Join-Path $firstPack "Cormier.Realtime.AspNetCore.$(($AspNetCoreIntegrationVersion -split '\+', 2)[0]).nupkg") `
        @('README.md', 'lib/net10.0/Cormier.Realtime.AspNetCore.dll') `
        ($metadata + ('<dependency id="Cormier.Realtime.Redis" version="[{0}, {1})"' -f $normalizedRedisVersion, $RedisAdapterCompatibilityUpperBound))
    Assert-NuGetPackage (Join-Path $firstPack "Cormier.Realtime.Browser.$(($BrowserPackageVersion -split '\+', 2)[0]).nupkg") `
        @('README.md', 'staticwebassets/cormier-realtime.js', 'staticwebassets/cormier-realtime.min.js', 'staticwebassets/cormier-realtime.iife.js', 'staticwebassets/cormier-realtime.iife.min.js', 'staticwebassets/types/index.d.ts', 'staticwebassets/version.json', 'buildTransitive/Cormier.Realtime.Browser.props') $metadata
    foreach ($packageId in @('Contracts', 'Client', 'Redis', 'AspNetCore', 'Browser')) {
        if (-not (Get-ChildItem -LiteralPath $firstPack -Filter "Cormier.Realtime.$packageId.*.snupkg" -File)) {
            throw "The symbol package for Cormier.Realtime.$packageId was not produced."
        }
    }
    $npmTarball = Get-ChildItem -LiteralPath $firstPack -Filter '*.tgz' -File | Select-Object -First 1
    $npmConsumer = Join-Path $stageRoot 'npm-consumer'
    New-Item -ItemType Directory -Path $npmConsumer -Force | Out-Null
    Invoke-ReleaseTool $npm @('init', '--yes') $npmConsumer
    Invoke-ReleaseTool $npm @('install', $npmTarball.FullName, '--ignore-scripts', '--no-audit', '--no-fund') $npmConsumer
    Invoke-ReleaseTool $node @('--input-type=module', '--eval', "import('@cormier/realtime').then(m => { if (typeof m.RealtimeClient !== 'function') process.exit(1); })") $npmConsumer
    Invoke-ReleaseTool $pwsh @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'Test-AspNetCorePackage.ps1'), '-AspNetCoreIntegrationVersion', $AspNetCoreIntegrationVersion, '-ContractsVersion', $ContractsVersion, '-RedisAdapterVersion', $RedisAdapterVersion, '-PackageSource', $firstPack, '-UpstreamPackageSource', $UpstreamPackageSource)
    Invoke-ReleaseTool $pwsh @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'Test-DotNetClientPackage.ps1'), '-DotNetClientVersion', $DotNetClientVersion, '-ContractsVersion', $ContractsVersion, '-PackageSource', $firstPack, '-UpstreamPackageSource', $UpstreamPackageSource)
    Invoke-ReleaseTool $pwsh @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'Test-BrowserPackage.ps1'), '-BrowserPackageVersion', $BrowserPackageVersion, '-PackageSource', $firstPack, '-UpstreamPackageSource', $UpstreamPackageSource)

    $phase = 'Evidence and promotion'
    $inventory = Get-ArtifactInventory $firstPack
    $manifest = [ordered]@{
        schemaVersion = 1
        sourceCommit = $commit
        createdUtc = [DateTimeOffset]::UtcNow.ToString('o')
        publishable = -not $SkipIntegrationTests -and -not $sourceDirty
        sourceTree = if ($sourceDirty) { 'dirty' } else { 'clean' }
        protocolVersion = '1.0'
        versions = [ordered]@{
            contracts = $ContractsVersion
            dotNetClient = $DotNetClientVersion
            redisAdapter = $RedisAdapterVersion
            aspNetCoreIntegration = $AspNetCoreIntegrationVersion
            browser = $BrowserPackageVersion
        }
        artifacts = $inventory
    }
    $candidateId = if ($sourceDirty) { "$commit-local" } else { $commit }
    $candidatePath = Join-Path $resolvedOutput $candidateId
    if (Test-Path -LiteralPath $candidatePath) {
        $existing = Get-ArtifactInventory $candidatePath | Where-Object { $_.name -notin @('manifest.json', 'SHA256SUMS') }
        if (($existing | ConvertTo-Json -Depth 5 -Compress) -ne ($inventory | ConvertTo-Json -Depth 5 -Compress)) {
            $existingByName = @{}
            foreach ($artifact in $existing) { $existingByName[$artifact.name] = $artifact }
            foreach ($artifact in $inventory) {
                $priorArtifact = $existingByName[$artifact.name]
                if ($null -eq $priorArtifact -or $priorArtifact.sha256 -ne $artifact.sha256) {
                    Write-ReleaseLog ERROR ("Candidate mismatch: {0}; existing={1}; rebuilt={2}" -f $artifact.name, $priorArtifact.sha256, $artifact.sha256)
                }
            }
            throw "Version conflict: candidate $candidatePath already exists with different bytes."
        }
        Assert-CandidateEvidence $candidatePath $manifest $inventory
        Write-ReleaseLog PASS "UNCHANGED: candidate $candidatePath already contains identical artifacts."
    }
    else {
        New-Item -ItemType Directory -Path $candidatePath -Force | Out-Null
        Get-ChildItem -LiteralPath $firstPack -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $candidatePath
        }
        $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $candidatePath 'manifest.json') -Encoding utf8NoBOM
        $inventory | ForEach-Object { '{0}  {1}' -f $_.sha256, $_.name } |
            Set-Content -LiteralPath (Join-Path $candidatePath 'SHA256SUMS') -Encoding utf8NoBOM
        Write-ReleaseLog PASS "CREATED: immutable candidate $candidatePath."
    }
    Write-ReleaseLog PASS ("SUMMARY: {0} artifacts; reproducible=true; publishable={1}; log={2}" -f $inventory.Count, $manifest.publishable, $logPath)
}
catch {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    Write-ReleaseLog ERROR $_.Exception.Message
    $scriptExitCode = if ($_.Exception.Message -like 'INVALID*') { 2 }
        elseif ($_.Exception.Message -like 'MISSING*' -or $_.Exception.Message -like 'UNUSABLE*') { 3 }
        else { 1 }
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        $resolvedStage = (Resolve-Path -LiteralPath $stageRoot).Path
        $resolvedTemp = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
        if ($resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
        else {
            Write-Warning "Temporary staging path was preserved because it resolved outside the configured temporary directory: $resolvedStage"
        }
    }
}
if ($scriptExitCode -ne 0) {
    exit $scriptExitCode
}
