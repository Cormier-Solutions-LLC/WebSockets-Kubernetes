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
    [ValidateRange(0, 1048576)][int]$PayloadBytes = 256,
    [ValidateSet('connection', 'fanout', 'burst', 'large-message', 'slow-client', 'soak')][string]$Scenario = 'burst',
    [ValidateRange(1, 86400)][int]$DurationSeconds = 60,
    [ValidateNotNullOrEmpty()][string]$OutputPath = 'artifacts/load-results.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-Envelope([string]$Type, [string]$Route, [int]$Bytes) {
    $payload = @{ data = ('x' * $Bytes) }
    return (@{
        version = '1.0'
        type = $Type
        correlationId = [Guid]::NewGuid().ToString('N')
        timestamp = [DateTimeOffset]::UtcNow.ToString('O')
        route = $Route
        payload = $payload
    } | ConvertTo-Json -Compress -Depth 4)
}

function Send-Text([System.Net.WebSockets.ClientWebSocket]$Socket, [string]$Text, [Threading.CancellationToken]$Token) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $segment = [ArraySegment[byte]]::new($bytes)
    $null = $Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, $Token).GetAwaiter().GetResult()
}

function Receive-One([System.Net.WebSockets.ClientWebSocket]$Socket, [Threading.CancellationToken]$Token) {
    $buffer = [byte[]]::new(65536)
    $segment = [ArraySegment[byte]]::new($buffer)
    do {
        $result = $Socket.ReceiveAsync($segment, $Token).GetAwaiter().GetResult()
        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'Server closed the connection during the load scenario.' }
    } until ($result.EndOfMessage)
}

$endpointUri = [Uri]$Endpoint
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [IO.Path]::GetDirectoryName($outputFullPath)
if ($outputDirectory) { [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null }
$timeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($DurationSeconds + 30))
$sockets = [Collections.Generic.List[Net.WebSockets.ClientWebSocket]]::new()
$latencies = [Collections.Generic.List[double]]::new()
$errors = [Collections.Generic.List[string]]::new()
$startedAt = [DateTimeOffset]::UtcNow
$timer = [Diagnostics.Stopwatch]::StartNew()
$sent = 0
$received = 0

try {
    for ($index = 0; $index -lt $Connections; $index++) {
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        $socket.Options.AddSubProtocol($SubProtocol)
        $socket.Options.SetRequestHeader('Origin', $Origin)
        $socket.Options.SetRequestHeader('Cookie', "$SessionCookieName=$SessionId")
        $connectTimer = [Diagnostics.Stopwatch]::StartNew()
        try {
            $null = $socket.ConnectAsync($endpointUri, $timeout.Token).GetAwaiter().GetResult()
            $latencies.Add($connectTimer.Elapsed.TotalMilliseconds)
            $sockets.Add($socket)
            if ($Scenario -in @('fanout', 'slow-client')) {
                Send-Text $socket (New-Envelope 'subscribe' "topics/$Topic" 0) $timeout.Token
                if ($Scenario -ne 'slow-client') { Receive-One $socket $timeout.Token; $received++ }
            }
        }
        catch {
            $socket.Dispose()
            $errors.Add("connect:$($_.Exception.GetType().Name)")
        }
    }

    $payloadSize = if ($Scenario -eq 'large-message') { [Math]::Max($PayloadBytes, 49152) } else { $PayloadBytes }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($DurationSeconds)
    foreach ($socket in $sockets) {
        for ($message = 0; $message -lt $MessagesPerConnection; $message++) {
            if ($Scenario -eq 'soak' -and [DateTimeOffset]::UtcNow -ge $deadline) { break }
            try {
                $sendTimer = [Diagnostics.Stopwatch]::StartNew()
                Send-Text $socket (New-Envelope 'publish' "topics/$Topic" $payloadSize) $timeout.Token
                $latencies.Add($sendTimer.Elapsed.TotalMilliseconds)
                $sent++
                if ($Scenario -eq 'fanout') {
                    foreach ($subscriber in $sockets) { Receive-One $subscriber $timeout.Token; $received++ }
                    Receive-One $socket $timeout.Token
                    $received++
                }
                elseif ($Scenario -ne 'slow-client') {
                    Receive-One $socket $timeout.Token
                    $received++
                }
                if ($Scenario -eq 'soak') { Start-Sleep -Milliseconds 100 }
            }
            catch {
                $errors.Add("send:$($_.Exception.GetType().Name)")
                break
            }
        }
    }

    if ($Scenario -eq 'slow-client') {
        Start-Sleep -Seconds ([Math]::Min($DurationSeconds, 30))
    }
}
finally {
    foreach ($socket in $sockets) {
        try {
            if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
                $null = $socket.CloseOutputAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'load_complete', [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            }
        } catch { $errors.Add("close:$($_.Exception.GetType().Name)") }
        $socket.Dispose()
    }
    $timeout.Dispose()
    $timer.Stop()
}

$ordered = @($latencies | Sort-Object)
function Get-Percentile([double]$percentile) {
    if ($ordered.Count -eq 0) { return 0 }
    $position = [Math]::Ceiling(($percentile / 100) * $ordered.Count) - 1
    return [Math]::Round($ordered[[Math]::Max(0, $position)], 3)
}

$result = [ordered]@{
    schemaVersion = 1
    scenario = $Scenario
    startedAt = $startedAt.ToString('O')
    durationSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 3)
    requestedConnections = $Connections
    establishedConnections = $sockets.Count
    messagesSent = $sent
    messagesReceived = $received
    payloadBytes = $payloadSize
    operationsPerSecond = if ($timer.Elapsed.TotalSeconds -gt 0) { [Math]::Round(($sockets.Count + $sent) / $timer.Elapsed.TotalSeconds, 3) } else { 0 }
    latencyMilliseconds = [ordered]@{ p50 = Get-Percentile 50; p95 = Get-Percentile 95; p99 = Get-Percentile 99; maximum = Get-Percentile 100 }
    errorCount = $errors.Count
    errors = @($errors | Group-Object | ForEach-Object { [ordered]@{ error = $_.Name; count = $_.Count } })
}

$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputFullPath -Encoding utf8NoBOM
$result | ConvertTo-Json -Depth 5
if ($errors.Count -gt 0) { exit 1 }
