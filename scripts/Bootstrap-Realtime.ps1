<#
.SYNOPSIS
    Validates and bootstraps the standalone Propago realtime solution.

.DESCRIPTION
    Performs prerequisite validation, creates the stable repository layout,
    restores locked NuGet packages, builds the Release configuration, validates
    the result, and writes a redacted execution log. Safe to run repeatedly.

.PARAMETER RepositoryRoot
    Repository root. Defaults to the parent of this script directory.

.PARAMETER Configuration
    MSBuild configuration. Defaults to Release.

.PARAMETER SkipRestore
    Skips NuGet restore.

.PARAMETER SkipBuild
    Skips the solution build.

.PARAMETER RequireContainer
    Requires Docker CLI and a reachable Docker daemon.

.PARAMETER DryRun
    Reports planned external operations without running restore or build.

.NOTES
    Version: 0.1.0
    Project: Propago Realtime Gateway
    Requires: PowerShell 7.x, .NET SDK 10.x, Git
    Output: .logs/Bootstrap-Realtime-<timestamp>.log
    Standard: refs/scripts-standard-v4.2.md
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),

    [Parameter()]
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [Parameter()]
    [switch]$SkipRestore,

    [Parameter()]
    [switch]$SkipBuild,

    [Parameter()]
    [switch]$RequireContainer,

    [Parameter()]
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
$solutionPath = Join-Path $resolvedRoot 'Propago.Realtime.sln'
$logDirectory = Join-Path $resolvedRoot '.logs'
$archiveDirectory = Join-Path $logDirectory 'Archive'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDirectory ("Bootstrap-Realtime-{0}.log" -f $timestamp)
$script:Summary = [ordered]@{
    Created = 0
    Updated = 0
    Unchanged = 0
    Skipped = 0
    Errors = 0
}

function Write-Phase {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)

    $heading = "PHASE - {0}" -f $Name
    Write-Log -Level 'INFO' -Message ('=' * 80)
    Write-Log -Level 'INFO' -Message $heading
    Write-Log -Level 'INFO' -Message ('=' * 80)
}

function Write-Log {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('DEBUG', 'INFO', 'PASS', 'WARN', 'ERROR', 'FATAL')][string]$Level,
        [Parameter(Mandatory)][string]$Message
    )

    $redacted = $Message -replace '(?i)(authorization\s*[:=]\s*)(?:(?:bearer|basic|digest)\s+)?\S+', '$1[REDACTED]'
    $redacted = $redacted -replace '(?i)((?:password|token|secret|cookie)\s*[:=]\s*)(?:"[^"]*"|''[^'']*''|\S+)', '$1[REDACTED]'
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $redacted
    $line | Tee-Object -FilePath $logPath -Append
}

function Assert-Command {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "MISSING: Required command '$Name' was not found on PATH."
    }

    Write-Log -Level 'PASS' -Message ("READY: command {0} at {1}" -f $Name, $command.Source)
}

function Ensure-Directory {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Path)

    if (Test-Path -LiteralPath $Path -PathType Container) {
        $script:Summary.Unchanged++
        Write-Log -Level 'PASS' -Message ("UNCHANGED: directory {0}" -f $Path)
        return
    }

    if ($DryRun -or -not $PSCmdlet.ShouldProcess($Path, 'Create directory')) {
        $script:Summary.Skipped++
        Write-Log -Level 'INFO' -Message ("SKIPPED: would create directory {0}" -f $Path)
        return
    }

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $script:Summary.Created++
    Write-Log -Level 'PASS' -Message ("CREATED: directory {0}" -f $Path)
}

function Invoke-CheckedCommand {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$Description
    )

    if ($DryRun -or -not $PSCmdlet.ShouldProcess($Description, $FilePath)) {
        $script:Summary.Skipped++
        Write-Log -Level 'INFO' -Message ("SKIPPED: {0}" -f $Description)
        return
    }

    Write-Log -Level 'INFO' -Message ("Running: {0}" -f $Description)
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
        $outputLine = [string]$_
        if (-not [string]::IsNullOrWhiteSpace($outputLine)) {
            Write-Log -Level 'INFO' -Message $outputLine
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw ("Command failed with exit code {0}: {1}" -f $LASTEXITCODE, $Description)
    }

    Write-Log -Level 'PASS' -Message ("Completed: {0}" -f $Description)
}

function Invoke-LogHousekeeping {
    [CmdletBinding(SupportsShouldProcess)]
    param()

    $cutoff = (Get-Date).AddDays(-7)
    $oldLogs = @(Get-ChildItem -LiteralPath $logDirectory -File -Filter '*.log' |
        Where-Object { $_.FullName -ne $logPath -and $_.LastWriteTime -lt $cutoff })
    if ($oldLogs.Count -eq 0) {
        Write-Log -Level 'INFO' -Message 'No completed logs require archival.'
        return
    }

    $archivePath = Join-Path $archiveDirectory ("Bootstrap-Logs-{0}.zip" -f $timestamp)
    if ($DryRun -or -not $PSCmdlet.ShouldProcess(
            ("{0} completed logs" -f $oldLogs.Count),
            ("Archive to {0}, validate, and remove sources" -f $archivePath))) {
        $script:Summary.Skipped += $oldLogs.Count
        Write-Log -Level 'INFO' -Message (
            "SKIPPED: would archive, validate, and remove {0} completed logs" -f $oldLogs.Count)
        return
    }

    Assert-Command -Name 'Compress-Archive'
    Ensure-Directory -Path $archiveDirectory
    Compress-Archive -LiteralPath $oldLogs.FullName -DestinationPath $archivePath -CompressionLevel Optimal

    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.Count -ne $oldLogs.Count -or (Get-Item -LiteralPath $archivePath).Length -le 0) {
            throw 'Archive validation failed; source logs were preserved.'
        }
    }
    finally {
        $archive.Dispose()
    }

    foreach ($oldLog in $oldLogs) {
        Remove-Item -LiteralPath $oldLog.FullName -Force
    }

    Write-Log -Level 'PASS' -Message ("Archived and validated {0} completed logs to {1}" -f $oldLogs.Count, $archivePath)
}

if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Repository root does not exist: $resolvedRoot"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$exitCode = 0
Push-Location -LiteralPath $resolvedRoot

try {
    Write-Phase -Name 'Prerequisite validation'
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        throw 'UNSUPPORTED: PowerShell 7 or later is required.'
    }
    Write-Log -Level 'PASS' -Message ("READY: PowerShell {0}" -f $PSVersionTable.PSVersion)

    Assert-Command -Name 'dotnet'
    Assert-Command -Name 'git'
    $dotnetVersion = & dotnet --version
    if ($LASTEXITCODE -ne 0 -or $dotnetVersion -notmatch '^10\.') {
        throw "UNSUPPORTED: .NET SDK 10.x is required; detected '$dotnetVersion'."
    }
    Write-Log -Level 'PASS' -Message ("READY: .NET SDK {0}" -f $dotnetVersion)

    if ($RequireContainer) {
        Assert-Command -Name 'docker'
        & docker info *> $null
        if ($LASTEXITCODE -ne 0) {
            throw 'UNREACHABLE: Docker daemon is required but not available.'
        }
        Write-Log -Level 'PASS' -Message 'READY: Docker daemon is reachable.'
    }

    if (-not (Test-Path -LiteralPath $solutionPath -PathType Leaf)) {
        throw "MISSING: Solution file not found: $solutionPath"
    }
    Write-Log -Level 'PASS' -Message ("READY: solution {0}" -f $solutionPath)

    Write-Phase -Name 'Repository layout'
    foreach ($relativePath in @('src', 'tests', 'helm', 'cluster', 'observability', 'scripts', 'docs')) {
        Ensure-Directory -Path (Join-Path $resolvedRoot $relativePath)
    }

    Write-Phase -Name 'Restore and build'
    if ($SkipRestore) {
        $script:Summary.Skipped++
        Write-Log -Level 'INFO' -Message 'SKIPPED: package restore requested by parameter.'
    }
    else {
        Invoke-CheckedCommand -FilePath 'dotnet' -ArgumentList @('restore', $solutionPath, '--locked-mode') -Description 'Restore locked NuGet dependencies'
    }

    if ($SkipBuild) {
        $script:Summary.Skipped++
        Write-Log -Level 'INFO' -Message 'SKIPPED: solution build requested by parameter.'
    }
    else {
        Invoke-CheckedCommand -FilePath 'dotnet' -ArgumentList @('build', $solutionPath, '--configuration', $Configuration, '--no-restore') -Description 'Build solution'
    }

    Write-Phase -Name 'Log housekeeping'
    Invoke-LogHousekeeping

    Write-Phase -Name 'Summary'
    foreach ($entry in $script:Summary.GetEnumerator()) {
        Write-Log -Level 'INFO' -Message ("{0}: {1}" -f $entry.Key, $entry.Value)
    }
    Write-Log -Level 'PASS' -Message ("Status: SUCCESS. Log: {0}" -f $logPath)
}
catch {
    $script:Summary.Errors++
    Write-Log -Level 'FATAL' -Message $_.Exception.Message
    Write-Log -Level 'ERROR' -Message ("Status: FAILURE. Log: {0}" -f $logPath)
    $exitCode = 1
}
finally {
    Pop-Location
}

exit $exitCode
