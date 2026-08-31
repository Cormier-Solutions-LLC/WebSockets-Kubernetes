[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^wss?://')][string]$Endpoint,
    [Parameter(Mandatory)][ValidatePattern('^https?://')][string]$Origin,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SessionId,
    [ValidateNotNullOrEmpty()][string]$SessionCookieName = 'cormier_session',
    [ValidateNotNullOrEmpty()][string]$SubProtocol = 'cormier.realtime.v1',
    [ValidateNotNullOrEmpty()][string]$Topic = 'load-test',
    [ValidateRange(1, 10000)][int]$Connections = 10,
    [ValidateRange(0, 100000)][int]$MessagesPerConnection = 100,
    [ValidateRange(0, 16000)][int]$PayloadBytes = 256,
    [ValidateSet('connection', 'fanout', 'burst', 'large-message', 'slow-client', 'soak')][string]$Scenario = 'burst',
    [ValidateRange(1, 86400)][int]$DurationSeconds = 60,
    [ValidateNotNullOrEmpty()][string]$OutputPath = 'artifacts/load-results.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runnerProject = Join-Path $PSScriptRoot '..' 'tools' 'Cormier.Realtime.LoadRunner' 'Cormier.Realtime.LoadRunner.csproj'
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$runnerArguments = @(
    '--endpoint', $Endpoint,
    '--origin', $Origin,
    '--session-cookie-name', $SessionCookieName,
    '--subprotocol', $SubProtocol,
    '--topic', $Topic,
    '--connections', $Connections,
    '--messages-per-connection', $MessagesPerConnection,
    '--payload-bytes', $PayloadBytes,
    '--scenario', $Scenario,
    '--duration-seconds', $DurationSeconds,
    '--output', $outputFullPath
)
$previousSessionId = [Environment]::GetEnvironmentVariable('CORMIER_LOAD_SESSION_ID', 'Process')
try {
    [Environment]::SetEnvironmentVariable('CORMIER_LOAD_SESSION_ID', $SessionId, 'Process')
    & dotnet run --project $runnerProject --configuration Release --no-launch-profile -- @runnerArguments
    $runnerExitCode = $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('CORMIER_LOAD_SESSION_ID', $previousSessionId, 'Process')
}
if ($runnerExitCode -ne 0) { exit $runnerExitCode }
