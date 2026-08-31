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
.PARAMETER CertificateAuthorityPath
  Optional PEM CA bundle used by curl. Install the same CA in the operating-system
  trust store when authenticated ClientWebSocket validation is requested.
.PARAMETER ConnectionReadyFile
  Optional marker written only after an authenticated WSS connection is established.
.PARAMETER ConnectionStopFile
  Optional signal file that keeps authenticated validation running until it appears.
.NOTES
  Requires: PowerShell 7.4 or later, kubectl, curl, a reachable Kubernetes cluster and DNS.
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
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikRelease = 'traefik',
    [Parameter()][string]$TraefikPodSelector = 'app.kubernetes.io/name=traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$MetalLbNamespace = 'metallb-system',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$MetalLbAdvertisement = 'development-traefik',
    [Parameter()][ValidateSet('l2', 'bgp')][string]$MetalLbAdvertisementMode = 'l2',
    [Parameter()][string]$MetalLbSpeakerSelector = 'component=speaker',
    [Parameter()][ValidatePattern('^[a-z0-9.-]+$')][string]$HostName = 'realtime.cormier.local',
    [Parameter()][ValidatePattern('^/[A-Za-z0-9._/-]*$')][string]$Path = '/realtime/ws',
    [Parameter()][ValidatePattern('^$|^https://[a-z0-9.-]+(:[0-9]{1,5})?$')][string]$Origin = '',
    [Parameter()][ValidateRange(1, 65535)][int]$ExternalPort = 443,
    [Parameter()][ValidatePattern('^$|^[0-9a-fA-F:.]+$')][string]$ExternalAddress = '',
    [Parameter()][string]$CertificateAuthorityPath = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateAuthoritySecretName = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateAuthoritySecretNamespace = '',
    [Parameter()][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$CertificateAuthoritySecretKey = 'tls.crt',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$ExpectedServedCertificateSecretName = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$ExpectedServedCertificateSecretNamespace = '',
    [Parameter()][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$ExpectedServedCertificateSecretKey = 'tls.crt',
    [Parameter()][ValidatePattern('^$|^[0-9a-fA-F:.]+$')][string]$ExpectedClientIp = '',
    [Parameter()][ValidateRange(0, 65535)][int]$GatewayMetricsPort = 0,
    [Parameter()][ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$TicketEnvironmentVariable = 'REALTIME_EDGE_TICKET',
    [Parameter()][string]$TicketRefreshCommand = '',
    [Parameter()][switch]$RequireReconnect,
    [Parameter()][switch]$ReconnectOnTransportFailure,
    [Parameter()][ValidateRange(5,3600)][int]$LongConnectionSeconds = 30,
    [Parameter()][ValidateRange(5,300)][int]$HeartbeatSeconds = 15,
    [Parameter()][ValidateRange(30,900)][int]$TimeoutSeconds = 120,
    [Parameter()][string]$ConnectionReadyFile = '',
    [Parameter()][string]$ConnectionStopFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$summary = [ordered]@{ Passed = 0; Skipped = 0; Failed = 0 }
$externalAuthority = if ($ExternalPort -eq 443) { $HostName } else { "${HostName}:$ExternalPort" }
$effectiveOrigin = if ([string]::IsNullOrWhiteSpace($Origin)) { "https://$externalAuthority" } else { $Origin }
$nullDevice = if ([OperatingSystem]::IsWindows()) { 'NUL' } else { '/dev/null' }
$temporaryCaPath = ''
$pinKubectlContext = $false

function Write-Result([ValidateSet('PASS', 'SKIP', 'FAIL')][string]$Status, [string]$Message) {
    $summary[($Status -replace 'PASS', 'Passed' -replace 'SKIP', 'Skipped' -replace 'FAIL', 'Failed')]++
    Write-Host "[$Status] $Message"
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Description) {
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $effectiveArguments = if ($pinKubectlContext -and [IO.Path]::GetFileNameWithoutExtension($File) -eq 'kubectl') { @('--context', $ExpectedContext) + $Arguments } else { $Arguments }
        $output = @(& $File @effectiveArguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        $stderr = [IO.File]::ReadAllText($stderrPath).Trim()
        if ($exitCode -ne 0) { throw "$Description failed with exit code $exitCode." }
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Warning $stderr }
        return ($output -join [Environment]::NewLine)
    }
    finally { Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue }
}

function Get-Json([string[]]$Arguments, [string]$Description) {
    return (Invoke-Checked kubectl ($Arguments + @('-o', 'json')) $Description | ConvertFrom-Json)
}

function Test-CertificateDnsName([string]$Pattern, [string]$Candidate) {
    if ($Pattern -ieq $Candidate) { return $true }
    if (-not $Pattern.StartsWith('*.')) { return $false }
    $suffix = $Pattern.Substring(1)
    if (-not $Candidate.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $prefix = $Candidate.Substring(0, $Candidate.Length - $suffix.Length)
    return -not [string]::IsNullOrWhiteSpace($prefix) -and -not $prefix.Contains('.')
}

function Assert-TraefikArguments([string[]]$Arguments, [string]$Source) {
    foreach ($timeoutName in @('readtimeout', 'writetimeout', 'idletimeout')) {
        $timeoutArgument = @($Arguments | Where-Object { $_ -match "respondingtimeouts\.$timeoutName=([0-9]+)s$" })
        if ($timeoutArgument.Count -ne 1 -or [int]([Regex]::Match($timeoutArgument[0], '=([0-9]+)s$').Groups[1].Value) -le $HeartbeatSeconds) {
            throw "$Source $timeoutName must be configured in seconds beyond the $HeartbeatSeconds-second heartbeat."
        }
    }
    foreach ($fieldName in @('RequestAddr', 'RequestPath', 'RequestPort')) {
        if ($Arguments -notcontains "--accesslog.fields.names.$fieldName=drop") { throw "$Source access logs do not drop $fieldName." }
    }
    if ($Arguments -notcontains '--accesslog.fields.headers.defaultmode=drop') { throw "$Source access logs do not drop request headers by default." }
}

function Test-TransportFailure([Exception]$Exception) {
    for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
        if ($current -is [Net.WebSockets.WebSocketException] -or $current -is [IO.IOException] -or
            $current -is [Net.Sockets.SocketException] -or $current -is [OperationCanceledException]) { return $true }
    }
    return $false
}

function Get-MetricValue([string]$MetricName, [string]$Labels) {
    $escapedLabels = [Regex]::Escape($Labels)
    $gatewayPods = Get-Json @('get', 'pods', '-n', $GatewayNamespace, '-l', "app.kubernetes.io/instance=$GatewayRelease") 'Read gateway metric targets'
    $effectiveMetricsPort = $GatewayMetricsPort
    if ($effectiveMetricsPort -eq 0) {
        $metricsDeployment = Get-Json @('get', 'deployment', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway metrics port'
        $namedPort = @($metricsDeployment.spec.template.spec.containers[0].ports | Where-Object { $_.name -eq 'http' } | Select-Object -First 1)
        if ($namedPort.Count -ne 1) { $namedPort = @($metricsDeployment.spec.template.spec.containers[0].ports | Select-Object -First 1) }
        if ($namedPort.Count -ne 1) { throw 'Gateway deployment does not expose a metrics-capable container port.' }
        $effectiveMetricsPort = [int]$namedPort[0].containerPort
    }
    $total = 0.0
    foreach ($pod in @($gatewayPods.items | Where-Object {
        $_.status.phase -eq 'Running' -and
        $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] -and
        @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
    })) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $localPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = (Get-Command kubectl).Source
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        foreach ($argument in @('port-forward', '-n', $GatewayNamespace, "pod/$($pod.metadata.name)", "${localPort}:$effectiveMetricsPort")) {
            $startInfo.ArgumentList.Add($argument)
        }
        $forward = [Diagnostics.Process]::Start($startInfo)
        $metrics = ''
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
            do {
                if ($forward.HasExited) { throw "Gateway metrics port-forward exited: $($forward.StandardError.ReadToEnd())" }
                try {
                    $metrics = (Invoke-WebRequest -Uri "http://127.0.0.1:${localPort}/metrics" -TimeoutSec 2).Content
                    break
                }
                catch {
                    Start-Sleep -Milliseconds 200
                }
            } while ([DateTimeOffset]::UtcNow -lt $deadline)
            if ([string]::IsNullOrWhiteSpace($metrics)) { throw 'Timed out reading gateway metrics through port-forward.' }
        }
        finally {
            if (-not $forward.HasExited) { $forward.Kill($true) }
            $forward.WaitForExit()
            $forward.Dispose()
        }
        $match = [Regex]::Match($metrics, "(?m)^$([Regex]::Escape($MetricName))\{$escapedLabels\}\s+([0-9.eE+-]+)$")
        if ($match.Success) { $total += [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture) }
    }
    return $total
}

try {
    foreach ($command in @('kubectl', 'curl')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "MISSING: $command is required." }
    }
    if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'UNSUPPORTED: PowerShell 7.4 or later is required.' }
    $context = Invoke-Checked kubectl @('config', 'current-context') 'Read Kubernetes context'
    if ($context.Trim() -ne $ExpectedContext) { throw "TARGET MISMATCH: expected '$ExpectedContext', detected '$($context.Trim())'." }
    $pinKubectlContext = $true

    $service = Get-Json @('get', 'service', $TraefikService, '-n', $TraefikNamespace) 'Read Traefik Service'
    if ($service.spec.type -ne 'LoadBalancer') { throw 'Traefik Service is not a LoadBalancer.' }
    if ($service.spec.externalTrafficPolicy -ne 'Local') { throw 'Traefik Service does not preserve source IP with externalTrafficPolicy Local.' }
    $pool = $service.metadata.annotations.'metallb.io/address-pool'
    if ([string]::IsNullOrWhiteSpace($pool)) { throw 'Traefik Service does not select a MetalLB address pool.' }
    $vip = @($service.status.loadBalancer.ingress | ForEach-Object { $_.ip } | Where-Object { $_ })[0]
    if ([string]::IsNullOrWhiteSpace($vip)) { throw 'Traefik LoadBalancer has no assigned VIP.' }
    Write-Result PASS "Traefik has VIP $vip from MetalLB pool $pool and preserves source IP."
    $connectionAddress = if ([string]::IsNullOrWhiteSpace($ExternalAddress)) { $vip } else { $ExternalAddress }

    $addressPool = Get-Json @('get', 'ipaddresspool', $pool, '-n', $MetalLbNamespace) 'Read MetalLB address pool'
    if (@($addressPool.spec.serviceAllocation.namespaces) -notcontains $TraefikNamespace) { throw 'MetalLB pool is not scoped to the Traefik namespace.' }
    $advertisementKind = if ($MetalLbAdvertisementMode -eq 'l2') { 'l2advertisement' } else { 'bgpadvertisement' }
    $advertisement = Get-Json @('get', $advertisementKind, $MetalLbAdvertisement, '-n', $MetalLbNamespace) "Read MetalLB $MetalLbAdvertisementMode advertisement"
    if (@($advertisement.spec.ipAddressPools) -notcontains $pool) { throw 'MetalLB advertisement does not reference the Traefik address pool.' }
    $traefikPods = Get-Json @('get', 'pods', '-n', $TraefikNamespace, '-l', $TraefikPodSelector) 'Read Traefik pods'
    $speakerPods = Get-Json @('get', 'pods', '-n', $MetalLbNamespace, '-l', $MetalLbSpeakerSelector) 'Read MetalLB speakers'
    $readyTraefikPods = @($traefikPods.items | Where-Object { $_.status.phase -eq 'Running' -and $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] -and @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1 })
    $traefikNodes = @($readyTraefikPods | ForEach-Object { $_.spec.nodeName } | Sort-Object -Unique)
    $speakerNodes = @($speakerPods.items | Where-Object { $_.status.phase -eq 'Running' -and $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] -and @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1 } | ForEach-Object { $_.spec.nodeName } | Sort-Object -Unique)
    $missingSpeakerNodes = @($traefikNodes | Where-Object { $speakerNodes -notcontains $_ })
    if ($traefikNodes.Count -lt 2 -or $missingSpeakerNodes.Count -gt 0) { throw 'MetalLB speakers are not ready on every node hosting a ready Traefik replica.' }
    Write-Result PASS "MetalLB pool, $MetalLbAdvertisementMode advertisement, and intended Traefik/speaker node placement are consistent."

    $traefikDeployment = Get-Json @('get', 'deployment', $TraefikRelease, '-n', $TraefikNamespace) 'Read Traefik timeout configuration'
    $traefikArguments = @($traefikDeployment.spec.template.spec.containers[0].args)
    $desiredTraefikReplicas = [int]$traefikDeployment.spec.replicas
    if ([long]$traefikDeployment.status.observedGeneration -lt [long]$traefikDeployment.metadata.generation -or
        [int]$traefikDeployment.status.updatedReplicas -ne $desiredTraefikReplicas -or
        [int]$traefikDeployment.status.readyReplicas -ne $desiredTraefikReplicas -or
        $readyTraefikPods.Count -ne $desiredTraefikReplicas) { throw 'Traefik running pods are not fully updated and ready.' }
    Assert-TraefikArguments $traefikArguments 'Traefik desired revision'
    foreach ($pod in $readyTraefikPods) { Assert-TraefikArguments @($pod.spec.containers[0].args) "Traefik pod/$($pod.metadata.name)" }
    Write-Result PASS 'Traefik desired and running revisions enforce heartbeat-safe timeouts and access-log redaction.'

    $certificate = Get-Json @('get', 'certificate', $CertificateName, '-n', $GatewayNamespace) 'Read edge Certificate'
    $ready = @($certificate.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' })
    if ($ready.Count -ne 1) { throw 'Edge Certificate is not Ready.' }
    if (@($certificate.spec.dnsNames | Where-Object { Test-CertificateDnsName ([string]$_) $HostName }).Count -eq 0) { throw "Certificate does not cover configured host $HostName." }
    if ([string]::IsNullOrWhiteSpace($certificate.spec.secretName)) { throw 'Certificate does not publish a TLS Secret.' }
    $notAfter = [DateTimeOffset]::Parse($certificate.status.notAfter)
    if ($notAfter -le [DateTimeOffset]::UtcNow) { throw 'Edge Certificate is expired.' }

    $route = Get-Json @('get', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway IngressRoute'
    if ($route.spec.tls.secretName -ne $certificate.spec.secretName) { throw 'IngressRoute and Certificate reference different TLS Secrets.' }
    $expectedMatch = "Host(``$HostName``) && Path(``$Path``)"
    if (@($route.spec.routes.match) -notcontains $expectedMatch) { throw 'IngressRoute does not match the configured host and path exactly.' }
    Write-Result PASS "Certificate is Ready for $HostName through $notAfter and is bound to the exact route."

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
    if ($dnsAddresses -notcontains $connectionAddress) { throw "DNS for $HostName does not contain configured external address $connectionAddress." }
    if ($connectionAddress -eq $vip) { Write-Result PASS "DNS resolves $HostName to the assigned VIP." }
    else { Write-Result PASS "DNS resolves $HostName to configured NAT address $connectionAddress; MetalLB separately assigned VIP $vip." }

    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath) -and -not [string]::IsNullOrWhiteSpace($CertificateAuthoritySecretName)) {
        throw 'Specify either CertificateAuthorityPath or CertificateAuthoritySecretName, not both.'
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthoritySecretName)) {
        $authorityNamespace = if ([string]::IsNullOrWhiteSpace($CertificateAuthoritySecretNamespace)) { $GatewayNamespace } else { $CertificateAuthoritySecretNamespace }
        $jsonPathKey = $CertificateAuthoritySecretKey -replace '\.', '\.'
        $encodedCertificate = Invoke-Checked kubectl @('get', 'secret', $CertificateAuthoritySecretName, '-n', $authorityNamespace, '-o', "jsonpath={.data.$jsonPathKey}") 'Read configured public CA certificate'
        if ([string]::IsNullOrWhiteSpace($encodedCertificate)) { throw "CA Secret $CertificateAuthoritySecretName does not contain key $CertificateAuthoritySecretKey." }
        $temporaryCaPath = [IO.Path]::GetTempFileName()
        [IO.File]::WriteAllBytes($temporaryCaPath, [Convert]::FromBase64String($encodedCertificate.Trim()))
        $CertificateAuthorityPath = $temporaryCaPath
    }
    elseif (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath)) {
        $CertificateAuthorityPath = [IO.Path]::GetFullPath($CertificateAuthorityPath)
        if (-not (Test-Path -LiteralPath $CertificateAuthorityPath -PathType Leaf)) { throw 'CertificateAuthorityPath must identify an existing file.' }
    }
    $curlCommon = @('--silent', '--show-error', '--noproxy', $HostName, '--max-time', "$TimeoutSeconds", '--resolve', "${HostName}:${ExternalPort}:$connectionAddress")
    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath)) { $curlCommon += @('--cacert', $CertificateAuthorityPath) }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedServedCertificateSecretName)) {
        $servedSecretNamespace = if ([string]::IsNullOrWhiteSpace($ExpectedServedCertificateSecretNamespace)) { $GatewayNamespace } else { $ExpectedServedCertificateSecretNamespace }
        $servedJsonPathKey = $ExpectedServedCertificateSecretKey -replace '\.', '\.'
        $encodedServedCertificate = Invoke-Checked kubectl @('get', 'secret', $ExpectedServedCertificateSecretName, '-n', $servedSecretNamespace, '-o', "jsonpath={.data.$servedJsonPathKey}") 'Read expected public served certificate'
        if ([string]::IsNullOrWhiteSpace($encodedServedCertificate)) { throw "Expected certificate Secret $ExpectedServedCertificateSecretName does not contain key $ExpectedServedCertificateSecretKey." }
        if ($null -eq ('Cormier.Realtime.EdgeValidation.ServedCertificate' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Cormier.Realtime.EdgeValidation;

public static class ServedCertificate
{
    public static string Sha256(string host, string address, int port)
    {
        using var client = new TcpClient();
        client.Connect(address, port);
        using var tls = new SslStream(client.GetStream(), false, (_, _, _, _) => true);
        tls.AuthenticateAsClient(host);
        using var certificate = new X509Certificate2(tls.RemoteCertificate ?? throw new AuthenticationException("The edge did not serve a certificate."));
        return Convert.ToHexString(SHA256.HashData(certificate.RawData));
    }
}
'@
        }
        $expectedCertificates = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
        try {
            $expectedCertificates.ImportFromPem([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedServedCertificate.Trim())))
            if ($expectedCertificates.Count -lt 1) { throw 'Expected served certificate data contains no public certificates.' }
            $expectedFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($expectedCertificates[0].RawData))
            $servedFingerprint = [Cormier.Realtime.EdgeValidation.ServedCertificate]::Sha256($HostName, $connectionAddress, $ExternalPort)
            if ($servedFingerprint -ne $expectedFingerprint) { throw 'The externally served TLS leaf does not match the configured expected Secret.' }
        }
        finally { foreach ($expectedCertificate in $expectedCertificates) { $expectedCertificate.Dispose() } }
        Write-Result PASS "Externally served TLS leaf matches Secret $servedSecretNamespace/$ExpectedServedCertificateSecretName."
    }

    $accessLogSinceTime = [DateTimeOffset]::UtcNow.ToString('O')
    $webSocketKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
    $upgradeArguments = $curlCommon + @(
        '--http1.1',
        '--header', 'Connection: Upgrade',
        '--header', 'Upgrade: websocket',
        '--header', 'Sec-WebSocket-Version: 13',
        '--header', "Sec-WebSocket-Key: $webSocketKey",
        '--header', 'Sec-WebSocket-Protocol: cormier.realtime.v1',
        '--header', "Origin: $effectiveOrigin",
        '--output', $nullDevice,
        '--write-out', '%{http_code}|%header{x-cormier-origin-validated}',
        "https://${externalAuthority}${Path}"
    )
    $routeStatus = Invoke-Checked curl $upgradeArguments 'Validate TLS route'
    if ($routeStatus.Trim() -ne '401|true') { throw "Approved Origin did not reach the session-authentication path; response was $($routeStatus.Trim())." }
    Write-Result PASS 'TLS handshake and authenticated approved route are reachable.'
    $invalidStatus = Invoke-Checked curl ($curlCommon + @('--output', $nullDevice, '--write-out', '%{http_code}', "https://${externalAuthority}/not-a-realtime-route")) 'Validate invalid route rejection'
    if ($invalidStatus.Trim() -ne '404') { throw "Invalid route returned unexpected status $($invalidStatus.Trim())." }
    Write-Result PASS 'Invalid route is rejected.'

    $wrongHostStatus = Invoke-Checked curl ($curlCommon + @('--header', "Host: invalid.$HostName", '--output', $nullDevice, '--write-out', '%{http_code}', "https://${externalAuthority}${Path}")) 'Validate invalid host rejection'
    if ($wrongHostStatus.Trim() -ne '404') { throw "Invalid host returned unexpected status $($wrongHostStatus.Trim())." }
    Write-Result PASS 'Invalid host is rejected.'

    $originFailuresBefore = Get-MetricValue 'cormier_realtime_authentication_total' 'method="origin",outcome="failure"'
    $invalidOriginArguments = $upgradeArguments.Clone()
    $originIndex = [Array]::IndexOf($invalidOriginArguments, "Origin: $effectiveOrigin")
    $invalidOriginArguments[$originIndex] = 'Origin: https://invalid.example'
    $invalidOriginStatus = Invoke-Checked curl $invalidOriginArguments 'Validate invalid Origin rejection'
    if ($invalidOriginStatus.Trim() -ne '401|false') { throw "Invalid Origin returned unexpected status $($invalidOriginStatus.Trim())." }
    $originFailuresAfter = Get-MetricValue 'cormier_realtime_authentication_total' 'method="origin",outcome="failure"'
    if ($originFailuresAfter -le $originFailuresBefore) { throw 'Invalid Origin did not increment the gateway Origin-rejection metric.' }
    Write-Result PASS 'Invalid Origin is rejected by the gateway and recorded without credential data.'

    if ([string]::IsNullOrWhiteSpace($ExpectedClientIp)) {
        Write-Result SKIP 'Observed source-IP validation skipped because ExpectedClientIp is unset.'
    }
    else {
        $accessLogs = Invoke-Checked kubectl @('logs', '-n', $TraefikNamespace, '-l', $TraefikPodSelector, "--since-time=$accessLogSinceTime", '--prefix=true') 'Read current-run redacted Traefik access logs'
        if ($accessLogs -notmatch ('"ClientHost"\s*:\s*"' + [Regex]::Escape($ExpectedClientIp) + '"')) { throw "Traefik did not observe expected client source IP $ExpectedClientIp." }
        Write-Result PASS "Traefik observed the expected client source IP $ExpectedClientIp."
    }

    $ticket = [Environment]::GetEnvironmentVariable($TicketEnvironmentVariable)
    if ([string]::IsNullOrWhiteSpace($ticket)) {
        Write-Result SKIP "Authenticated WSS validation skipped because $TicketEnvironmentVariable is unset."
    }
    else {
        $socket = $null
        $trustedRoots = $null
        $socketInvoker = $null
        if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath)) {
            $trustedRoots = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
            $trustedRoots.ImportFromPemFile($CertificateAuthorityPath)
            if ($trustedRoots.Count -eq 0) { throw 'The configured CA bundle contains no certificates.' }
        }
        if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath) -or -not [string]::IsNullOrWhiteSpace($ExternalAddress)) {
            if ($null -eq ('Cormier.Realtime.EdgeValidation.CustomRootValidator' -as [type])) {
                Add-Type -TypeDefinition @'
using System.Net.Security;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;

namespace Cormier.Realtime.EdgeValidation;

public static class CustomRootValidator
{
    public static RemoteCertificateValidationCallback Create(X509Certificate2Collection trustedRoots) =>
        (_, certificate, peerChain, errors) =>
        {
            if (certificate is null || (errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0)
            {
                return false;
            }

            using var candidate = new X509Certificate2(certificate);
            using var customChain = new X509Chain();
            customChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            customChain.ChainPolicy.CustomTrustStore.AddRange(trustedRoots);
            if (peerChain is not null)
            {
                for (var index = 1; index < peerChain.ChainElements.Count; index++)
                {
                    customChain.ChainPolicy.ExtraStore.Add(peerChain.ChainElements[index].Certificate);
                }
            }
            customChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return customChain.Build(candidate);
        };

    public static HttpMessageInvoker CreateInvoker(string targetAddress, int targetPort, X509Certificate2Collection trustedRoots)
    {
        var handler = new SocketsHttpHandler { UseProxy = false };
        handler.ConnectCallback = async (_, cancellationToken) =>
        {
            var address = IPAddress.Parse(targetAddress);
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, targetPort), cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        };
        if (trustedRoots is not null)
        {
            handler.SslOptions.RemoteCertificateValidationCallback = Create(trustedRoots);
        }
        return new HttpMessageInvoker(handler, disposeHandler: true);
    }
}
'@
            }
        }
        try {
            function Connect-AuthenticatedSocket([string]$EphemeralTicket) {
                $candidateSocket = [Net.WebSockets.ClientWebSocket]::new()
                $candidateInvoker = $null
                $connectTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
                try {
                    $candidateSocket.Options.AddSubProtocol('cormier.realtime.v1')
                    $candidateSocket.Options.SetRequestHeader('Origin', $effectiveOrigin)
                    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath) -and [string]::IsNullOrWhiteSpace($ExternalAddress)) {
                        $candidateSocket.Options.RemoteCertificateValidationCallback = [Cormier.Realtime.EdgeValidation.CustomRootValidator]::Create($trustedRoots)
                    }
                    $uri = [Uri]::new("wss://${externalAuthority}${Path}?ticket=$([Uri]::EscapeDataString($EphemeralTicket))")
                    if ([string]::IsNullOrWhiteSpace($ExternalAddress)) { $null = $candidateSocket.ConnectAsync($uri, $connectTimeout.Token).GetAwaiter().GetResult() }
                    else {
                        if ($null -eq ('Cormier.Realtime.EdgeValidation.CustomRootValidator' -as [type])) { throw 'The pinned WSS transport helper could not be loaded.' }
                        $candidateInvoker = [Cormier.Realtime.EdgeValidation.CustomRootValidator]::CreateInvoker($ExternalAddress, $ExternalPort, $trustedRoots)
                        $null = $candidateSocket.ConnectAsync($uri, $candidateInvoker, $connectTimeout.Token).GetAwaiter().GetResult()
                    }
                    return [pscustomobject]@{ Socket = $candidateSocket; Invoker = $candidateInvoker }
                }
                catch { $candidateSocket.Dispose(); if ($null -ne $candidateInvoker) { $candidateInvoker.Dispose() }; throw }
                finally { $connectTimeout.Dispose() }
            }
            $connected = Connect-AuthenticatedSocket $ticket
            $socket = $connected.Socket
            $socketInvoker = $connected.Invoker
            if (-not [string]::IsNullOrWhiteSpace($ConnectionReadyFile)) {
                [IO.File]::WriteAllText([IO.Path]::GetFullPath($ConnectionReadyFile), [DateTimeOffset]::UtcNow.ToString('O'))
            }
            $validationDeadline = [DateTimeOffset]::UtcNow.AddSeconds($LongConnectionSeconds)
            $receiveBuffer = [byte[]]::new(16384)
            $stopSignalObserved = $false
            $reconnectCount = 0
            do {
                $stopSignalObserved = -not [string]::IsNullOrWhiteSpace($ConnectionStopFile) -and (Test-Path -LiteralPath $ConnectionStopFile)
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
                $reconnectRequired = $false
                $receiveTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
                try {
                    $null = $socket.SendAsync(
                        [ArraySegment[byte]]::new($pingBytes),
                        [Net.WebSockets.WebSocketMessageType]::Text,
                        $true,
                        $receiveTimeout.Token).GetAwaiter().GetResult()
                    while (-not $acknowledged) {
                        $result = $socket.ReceiveAsync(
                            [ArraySegment[byte]]::new($receiveBuffer),
                            $receiveTimeout.Token).GetAwaiter().GetResult()
                        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                            if ([int]$socket.CloseStatus -ne 1012) { throw "WSS connection closed during validation with status $($socket.CloseStatus)." }
                            if ([string]::IsNullOrWhiteSpace($TicketRefreshCommand)) { throw 'WSS service restart requires TicketRefreshCommand to obtain a fresh single-use ticket.' }
                            $refreshedTicket = (Invoke-Checked $TicketRefreshCommand @() 'Refresh WSS ticket after service restart').Trim()
                            if ($refreshedTicket -notmatch '^[A-Za-z0-9_-]{32,128}$') { throw 'TicketRefreshCommand returned an invalid ticket.' }
                            $socket.Dispose()
                            if ($null -ne $socketInvoker) { $socketInvoker.Dispose(); $socketInvoker = $null }
                            $connected = Connect-AuthenticatedSocket $refreshedTicket
                            $socket = $connected.Socket
                            $socketInvoker = $connected.Invoker
                            $reconnectCount++
                            $reconnectRequired = $true
                            break
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
                catch {
                    if (-not $ReconnectOnTransportFailure -or -not (Test-TransportFailure $_.Exception)) { throw }
                    if ([string]::IsNullOrWhiteSpace($TicketRefreshCommand)) { throw 'WSS transport recovery requires TicketRefreshCommand to obtain a fresh single-use ticket.' }
                    $refreshedTicket = (Invoke-Checked $TicketRefreshCommand @() 'Refresh WSS ticket after transport failure').Trim()
                    if ($refreshedTicket -notmatch '^[A-Za-z0-9_-]{32,128}$') { throw 'TicketRefreshCommand returned an invalid ticket.' }
                    $socket.Dispose()
                    if ($null -ne $socketInvoker) { $socketInvoker.Dispose(); $socketInvoker = $null }
                    $connected = Connect-AuthenticatedSocket $refreshedTicket
                    $socket = $connected.Socket
                    $socketInvoker = $connected.Invoker
                    $reconnectCount++
                    $reconnectRequired = $true
                }
                finally {
                    $receiveTimeout.Dispose()
                }

                if ($reconnectRequired) { continue }
                if ($stopSignalObserved) { break }

                $remainingSeconds = ($validationDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
                if ($remainingSeconds -gt 0) {
                    Start-Sleep -Seconds ([Math]::Min(10, $remainingSeconds))
                }
            } while ([DateTimeOffset]::UtcNow -lt $validationDeadline)
            if (-not [string]::IsNullOrWhiteSpace($ConnectionStopFile) -and -not $stopSignalObserved) { throw 'Authenticated WSS continuity timed out before receiving its stop signal.' }
            if ($RequireReconnect -and $reconnectCount -lt 1) { throw 'Authenticated WSS continuity did not observe and recover from a service-restart close.' }
            Write-Result PASS "Authenticated WSS continuity completed with $reconnectCount service-restart reconnect(s)."
        }
        finally {
            try { if ($null -ne $socket) { $socket.Dispose() } } catch {}
            try { if ($null -ne $socketInvoker) { $socketInvoker.Dispose() } } catch {}
            try { if ($null -ne $trustedRoots) { foreach ($root in $trustedRoots) { $root.Dispose() } } } catch {}
        }
    }
}
catch {
    Write-Result FAIL $_.Exception.Message
    exit 1
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($temporaryCaPath) -and (Test-Path -LiteralPath $temporaryCaPath)) {
        Remove-Item -LiteralPath $temporaryCaPath -Force
    }
    $summary.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
}
