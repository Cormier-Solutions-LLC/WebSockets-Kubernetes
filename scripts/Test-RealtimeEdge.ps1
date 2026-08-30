<#
.SYNOPSIS
  Validates the deployed Cormier realtime Traefik and MetalLB edge.
.DESCRIPTION
  Performs non-mutating DNS, TLS, routing, readiness, and optional authenticated
  WSS long-connection validation. The ticket is read only from an environment
  variable and is never logged.
.PARAMETER ExpectedContext
  Required kubectl context; prevents validation against an unintended cluster.
.PARAMETER GatewayNamespace
  Namespace containing the gateway deployment and Certificate.
.PARAMETER TraefikNamespace
  Namespace containing the Traefik LoadBalancer Service.
.PARAMETER TicketEnvironmentVariable
  Environment variable that holds an ephemeral single-use WSS ticket.
.NOTES
  Requires: PowerShell 7, kubectl, curl, a reachable Kubernetes cluster and DNS.
  Standard: refs/scripts-standard-v4.2.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExpectedContext,
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayNamespace = 'development-realtime',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikNamespace = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayRelease = 'development-realtime',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateName = 'realtime-cormier-local',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikService = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9.-]+$')][string]$HostName = 'realtime.cormier.local',
    [Parameter()][ValidatePattern('^/[A-Za-z0-9._/-]*$')][string]$Path = '/realtime/ws',
    [Parameter()][ValidatePattern('^https://[a-z0-9.-]+$')][string]$Origin = 'https://cormier.local',
    [Parameter()][ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$TicketEnvironmentVariable = 'REALTIME_EDGE_TICKET',
    [Parameter()][ValidateRange(5,300)][int]$LongConnectionSeconds = 30,
    [Parameter()][ValidateRange(30,600)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$summary = [ordered]@{ Passed = 0; Skipped = 0; Failed = 0 }

function Write-Result([ValidateSet('PASS', 'SKIP', 'FAIL')][string]$Status, [string]$Message) {
    $summary[($Status -replace 'PASS', 'Passed' -replace 'SKIP', 'Skipped' -replace 'FAIL', 'Failed')]++
    Write-Host "[$Status] $Message"
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Description) {
    $output = @(& $File @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
    return ($output -join [Environment]::NewLine)
}

function Get-Json([string[]]$Arguments, [string]$Description) {
    return (Invoke-Checked kubectl ($Arguments + @('-o', 'json')) $Description | ConvertFrom-Json)
}

try {
    foreach ($command in @('kubectl', 'curl')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "MISSING: $command is required." }
    }
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'UNSUPPORTED: PowerShell 7 or later is required.' }
    $context = Invoke-Checked kubectl @('config', 'current-context') 'Read Kubernetes context'
    if ($context.Trim() -ne $ExpectedContext) { throw "TARGET MISMATCH: expected '$ExpectedContext', detected '$($context.Trim())'." }

    $service = Get-Json @('get', 'service', $TraefikService, '-n', $TraefikNamespace) 'Read Traefik Service'
    if ($service.spec.type -ne 'LoadBalancer') { throw 'Traefik Service is not a LoadBalancer.' }
    if ($service.spec.externalTrafficPolicy -ne 'Local') { throw 'Traefik Service does not preserve source IP with externalTrafficPolicy Local.' }
    $pool = $service.metadata.annotations.'metallb.io/address-pool'
    if ([string]::IsNullOrWhiteSpace($pool)) { throw 'Traefik Service does not select a MetalLB address pool.' }
    $vip = @($service.status.loadBalancer.ingress | ForEach-Object { $_.ip } | Where-Object { $_ })[0]
    if ([string]::IsNullOrWhiteSpace($vip)) { throw 'Traefik LoadBalancer has no assigned VIP.' }
    Write-Result PASS "Traefik has VIP $vip from MetalLB pool $pool and preserves source IP."

    $certificate = Get-Json @('get', 'certificate', $CertificateName, '-n', $GatewayNamespace) 'Read edge Certificate'
    $ready = @($certificate.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' })
    if ($ready.Count -ne 1) { throw 'Edge Certificate is not Ready.' }
    Write-Result PASS 'Certificate is Ready.'

    $gateway = Get-Json @('get', 'deployment', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway Deployment'
    if ($gateway.status.availableReplicas -lt 2) { throw 'Fewer than two gateway replicas are available for failover.' }
    $gatewayService = Get-Json @('get', 'service', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway Service'
    if ($gatewayService.spec.type -ne 'ClusterIP') { throw 'Gateway Service must remain private with type ClusterIP.' }
    $endpointSlices = Get-Json @('get', 'endpointslice', '-n', $GatewayNamespace, '-l', "kubernetes.io/service-name=$GatewayRelease") 'Read gateway EndpointSlices'
    # Kubernetes omits `terminating` for healthy endpoints, so only explicit true excludes an endpoint.
    $readyEndpoints = @($endpointSlices.items.endpoints | Where-Object { $_.conditions.ready -eq $true -and $_.conditions.terminating -ne $true })
    if ($readyEndpoints.Count -lt 2) { throw 'Fewer than two non-terminating gateway endpoints are routable.' }
    Write-Result PASS 'At least two ready, non-terminating gateway endpoints are routable.'

    $dnsAddresses = @([Net.Dns]::GetHostAddresses($HostName) | ForEach-Object { $_.IPAddressToString })
    if ($dnsAddresses -notcontains $vip) { throw "DNS for $HostName does not contain assigned VIP $vip." }
    Write-Result PASS "DNS resolves $HostName to the assigned VIP."

    $webSocketKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
    $upgradeArguments = @(
        '--silent', '--show-error', '--http1.1', '--max-time', "$TimeoutSeconds",
        '--resolve', "${HostName}:443:$vip",
        '--header', 'Connection: Upgrade',
        '--header', 'Upgrade: websocket',
        '--header', 'Sec-WebSocket-Version: 13',
        '--header', "Sec-WebSocket-Key: $webSocketKey",
        '--header', 'Sec-WebSocket-Protocol: cormier.realtime.v1',
        '--header', "Origin: $Origin",
        '--output', '/dev/null',
        '--write-out', '%{http_code}',
        "https://${HostName}${Path}"
    )
    $routeStatus = Invoke-Checked curl $upgradeArguments 'Validate TLS route'
    if ($routeStatus.Trim() -notin @('401', '426')) { throw "Approved route returned unexpected status $($routeStatus.Trim())." }
    Write-Result PASS 'TLS handshake and authenticated approved route are reachable.'
    $invalidStatus = Invoke-Checked curl @('--silent', '--show-error', '--max-time', "$TimeoutSeconds", '--resolve', "${HostName}:443:$vip", '--output', '/dev/null', '--write-out', '%{http_code}', "https://${HostName}/not-a-realtime-route") 'Validate invalid route rejection'
    if ($invalidStatus.Trim() -ne '404') { throw "Invalid route returned unexpected status $($invalidStatus.Trim())." }
    Write-Result PASS 'Invalid route is rejected.'

    $ticket = [Environment]::GetEnvironmentVariable($TicketEnvironmentVariable)
    if ([string]::IsNullOrWhiteSpace($ticket)) {
        Write-Result SKIP "Authenticated WSS validation skipped because $TicketEnvironmentVariable is unset."
    }
    else {
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        $connectionTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
        $socket.Options.AddSubProtocol('cormier.realtime.v1')
        $socket.Options.SetRequestHeader('Origin', $Origin)
        try {
            $uri = [Uri]::new("wss://${HostName}${Path}?ticket=$([Uri]::EscapeDataString($ticket))")
            $socket.ConnectAsync($uri, $connectionTimeout.Token).GetAwaiter().GetResult()
            $validationDeadline = [DateTimeOffset]::UtcNow.AddSeconds($LongConnectionSeconds)
            $receiveBuffer = [byte[]]::new(16384)
            do {
                $correlationId = [Guid]::NewGuid().ToString('N')
                $ping = [ordered]@{
                    version = '1.0'
                    type = 'ping'
                    correlationId = $correlationId
                    timestamp = [DateTimeOffset]::UtcNow.ToString('O')
                    route = 'system/heartbeat'
                } | ConvertTo-Json -Compress
                $pingBytes = [Text.Encoding]::UTF8.GetBytes($ping)
                $acknowledged = $false
                $receiveTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
                try {
                    $socket.SendAsync(
                        [ArraySegment[byte]]::new($pingBytes),
                        [Net.WebSockets.WebSocketMessageType]::Text,
                        $true,
                        $receiveTimeout.Token).GetAwaiter().GetResult()
                    while (-not $acknowledged) {
                        $result = $socket.ReceiveAsync(
                            [ArraySegment[byte]]::new($receiveBuffer),
                            $receiveTimeout.Token).GetAwaiter().GetResult()
                        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                            throw "WSS connection closed during validation with status $($socket.CloseStatus)."
                        }
                        if ($result.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text -or -not $result.EndOfMessage) {
                            throw 'WSS server returned an invalid validation response.'
                        }

                        $message = [Text.Encoding]::UTF8.GetString($receiveBuffer, 0, $result.Count) | ConvertFrom-Json
                        if ($message.correlationId -eq $correlationId) {
                            if ($message.type -ne 'ack') {
                                throw "WSS ping was not acknowledged; received '$($message.type)'."
                            }
                            $acknowledged = $true
                        }
                    }
                }
                finally {
                    $receiveTimeout.Dispose()
                }

                $remainingSeconds = ($validationDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
                if ($remainingSeconds -gt 0) {
                    Start-Sleep -Seconds ([Math]::Min(10, $remainingSeconds))
                }
            } while ([DateTimeOffset]::UtcNow -lt $validationDeadline)
            Write-Result PASS "Authenticated WSS connection exchanged ping traffic for $LongConnectionSeconds seconds."
        }
        finally {
            try { $connectionTimeout.Dispose() } catch {}
            try { $socket.Dispose() } catch {}
        }
    }
}
catch {
    Write-Result FAIL $_.Exception.Message
    exit 1
}
finally {
    $summary.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
}
