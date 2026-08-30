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
$runnerAssembly = Join-Path $PSScriptRoot '..' 'tools' 'Cormier.Realtime.LoadRunner' 'bin' 'Release' 'net10.0' 'Cormier.Realtime.LoadRunner.dll'
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$runnerArguments = @(
    '--endpoint', $Endpoint,
    '--origin', $Origin,
    '--session-id', $SessionId,
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
if (Test-Path -LiteralPath $runnerAssembly) {
    & dotnet $runnerAssembly @runnerArguments
}
else {
    & dotnet run --project $runnerProject --configuration Release -- @runnerArguments
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
