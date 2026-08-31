<#
.SYNOPSIS
  Runs one reversible failure-recovery test against a non-production realtime edge.
.DESCRIPTION
  Verifies the exact kubectl context, captures redacted evidence, injects one bounded
  failure, restores state in a finally block, and proves recovery with the read-only
  edge validator. Private keys and credential values are never read; only the public
  CA certificate is read when explicitly selected for trust validation.
.NOTES
  Version: 1.0.0
  Requires: PowerShell 7, kubectl, curl, and an approved non-production cluster.
  Standard: refs/scripts-standard-v4.2.md
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidateSet('GatewayPodDelete', 'GatewayRollout', 'GatewayBackendOutage', 'TraefikRestart', 'MetalLbSpeakerRestart', 'CertificateRenewal', 'CertificateRouteMismatch', 'RouteMismatch', 'NodeDrain')][string]$Scenario,
    [Parameter(Mandatory)][string]$ExpectedContext,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$Environment,
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayNamespace = 'development-realtime',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayRelease = 'development-realtime',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikNamespace = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikRelease = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikService = 'traefik',
    [Parameter()][string]$TraefikPodSelector = 'app.kubernetes.io/name=traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateName = 'realtime-cormier-local',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$MetalLbNamespace = 'metallb-system',
    [Parameter()][string]$MetalLbSpeakerSelector = 'component=speaker',
    [Parameter()][ValidatePattern('^[a-z0-9.-]+$')][string]$HostName = 'realtime.cormier.local',
    [Parameter()][ValidatePattern('^/[A-Za-z0-9._/-]*$')][string]$Path = '/realtime/ws',
    [Parameter()][ValidatePattern('^$|^https://[a-z0-9.-]+(:[0-9]{1,5})?$')][string]$Origin = '',
    [Parameter()][ValidateRange(1, 65535)][int]$ExternalPort = 443,
    [Parameter()][ValidatePattern('^$|^[0-9a-fA-F:.]+$')][string]$ExternalAddress = '',
    [Parameter()][string]$CertificateAuthorityPath = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateAuthoritySecretName = '',
    [Parameter()][string]$NodeName = '',
    [Parameter()][switch]$AllowNodeDrain,
    [Parameter()][ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
    [Parameter()][ValidateRange(5, 300)][int]$HeartbeatSeconds = 15,
    [Parameter()][string]$EvidenceDirectory = '.evidence/edge'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$changed = $false
$originalReplicas = 0
$originalRouteMatch = ''
$originalTlsSecret = ''
$nodeWasUnschedulable = $false
$externalAuthority = if ($ExternalPort -eq 443) { $HostName } else { "${HostName}:$ExternalPort" }
$effectiveOrigin = if ([string]::IsNullOrWhiteSpace($Origin)) { "https://$externalAuthority" } else { $Origin }

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Description) {
    $output = @(& $File @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
    return ($output -join [Environment]::NewLine)
}

function Get-KubeJson([string[]]$Arguments, [string]$Description) {
    return (Invoke-Checked kubectl ($Arguments + @('-o', 'json')) $Description | ConvertFrom-Json)
}

function Wait-Rollout([string]$Kind, [string]$Name, [string]$Namespace) {
    Invoke-Checked kubectl @('rollout', 'status', "$Kind/$Name", '-n', $Namespace, "--timeout=${TimeoutSeconds}s") "Wait for $Kind/$Name rollout" | Out-Null
}

function Wait-DeploymentAvailableReplicas([int]$ExpectedReplicas) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $deployment = Get-KubeJson @('get', 'deployment', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway availability'
        $property = $deployment.status.PSObject.Properties['availableReplicas']
        $availableReplicas = if ($null -eq $property) { 0 } else { [int]$property.Value }
        if ($availableReplicas -eq $ExpectedReplicas) { return }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Gateway did not reach $ExpectedReplicas available replicas within $TimeoutSeconds seconds."
}

function Set-RouteValue([string]$JsonPointer, [string]$Value, [string]$Description) {
    $patch = @{ op = 'replace'; path = $JsonPointer; value = $Value } | ConvertTo-Json -Compress -AsArray
    Invoke-Checked kubectl @('patch', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace, '--type=json', '-p', $patch) $Description | Out-Null
}

function Invoke-EdgeValidation {
    $arguments = @(
        '-NoProfile', '-File', (Join-Path $PSScriptRoot 'Test-RealtimeEdge.ps1'),
        '-ExpectedContext', $ExpectedContext, '-GatewayNamespace', $GatewayNamespace,
        '-GatewayRelease', $GatewayRelease, '-TraefikNamespace', $TraefikNamespace,
        '-TraefikService', $TraefikService, '-TraefikRelease', $TraefikRelease, '-TraefikPodSelector', $TraefikPodSelector, '-CertificateName', $CertificateName,
        '-HostName', $HostName, '-Path', $Path, '-Origin', $effectiveOrigin,
        '-ExternalPort', $ExternalPort,
        '-TimeoutSeconds', $TimeoutSeconds, '-HeartbeatSeconds', $HeartbeatSeconds
    )
    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath)) {
        $arguments += @('-CertificateAuthorityPath', $CertificateAuthorityPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthoritySecretName)) { $arguments += @('-CertificateAuthoritySecretName', $CertificateAuthoritySecretName) }
    if (-not [string]::IsNullOrWhiteSpace($ExternalAddress)) { $arguments += @('-ExternalAddress', $ExternalAddress) }
    return Invoke-Checked pwsh $arguments 'Run external edge validation'
}

function Invoke-EdgeValidationWithRetry {
    $lastError = $null
    foreach ($attempt in 1..3) {
        try { return Invoke-EdgeValidation }
        catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
        }
    }
    throw $lastError
}

function Get-ExternalStatus {
    $service = Get-KubeJson @('get', 'service', $TraefikService, '-n', $TraefikNamespace) 'Read Traefik Service'
    $vip = @($service.status.loadBalancer.ingress | ForEach-Object { $_.ip } | Where-Object { $_ })[0]
    if ([string]::IsNullOrWhiteSpace($vip)) { throw 'Traefik Service has no assigned VIP.' }
    $connectionAddress = if ([string]::IsNullOrWhiteSpace($ExternalAddress)) { $vip } else { $ExternalAddress }
    $nullDevice = if ([OperatingSystem]::IsWindows()) { 'NUL' } else { '/dev/null' }
    $temporaryCaPath = ''
    $effectiveCaPath = $CertificateAuthorityPath
    try {
        if ([string]::IsNullOrWhiteSpace($effectiveCaPath) -and -not [string]::IsNullOrWhiteSpace($CertificateAuthoritySecretName)) {
            $encodedCertificate = Invoke-Checked kubectl @('get', 'secret', $CertificateAuthoritySecretName, '-n', $GatewayNamespace, '-o', 'jsonpath={.data.tls\.crt}') 'Read public CA certificate'
            $temporaryCaPath = [IO.Path]::GetTempFileName()
            [IO.File]::WriteAllBytes($temporaryCaPath, [Convert]::FromBase64String($encodedCertificate.Trim()))
            $effectiveCaPath = $temporaryCaPath
        }
        $arguments = @('--silent', '--show-error', '--noproxy', $HostName, '--max-time', "$TimeoutSeconds", '--resolve', "${HostName}:${ExternalPort}:$connectionAddress", '--output', $nullDevice, '--write-out', '%{http_code}')
        if (-not [string]::IsNullOrWhiteSpace($effectiveCaPath)) { $arguments += @('--cacert', $effectiveCaPath) }
        $arguments += "https://${externalAuthority}${Path}"
        return (Invoke-Checked curl $arguments 'Read external edge status').Trim()
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($temporaryCaPath) -and (Test-Path -LiteralPath $temporaryCaPath)) { Remove-Item -LiteralPath $temporaryCaPath -Force }
    }
}

foreach ($command in @('kubectl', 'curl', 'pwsh')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "MISSING: $command is required." }
}
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'UNSUPPORTED: PowerShell 7 or later is required.' }
$context = (Invoke-Checked kubectl @('config', 'current-context') 'Read Kubernetes context').Trim()
if ($context -ne $ExpectedContext) { throw "TARGET MISMATCH: expected '$ExpectedContext', detected '$context'." }
if ($Environment -match '^(prod|production)$') { throw 'SAFETY STOP: failure tests cannot target an environment named prod or production.' }
if ($Scenario -eq 'NodeDrain' -and (-not $AllowNodeDrain -or [string]::IsNullOrWhiteSpace($NodeName))) {
    throw 'NodeDrain requires both -AllowNodeDrain and an explicit -NodeName.'
}

$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$evidencePath = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) "$Environment-$Scenario-$timestamp"
[IO.Directory]::CreateDirectory($evidencePath) | Out-Null
$metadata = [ordered]@{ scenario = $Scenario; environment = $Environment; context = $context; startedUtc = [DateTimeOffset]::UtcNow.ToString('O'); host = $HostName; path = $Path }
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidencePath 'metadata.json') -Encoding utf8NoBOM

try {
    Invoke-EdgeValidationWithRetry | Set-Content -LiteralPath (Join-Path $evidencePath 'baseline.log') -Encoding utf8NoBOM
    if (-not $PSCmdlet.ShouldProcess("$Environment on $ExpectedContext", "Inject $Scenario and automatically restore it")) { return }

    switch ($Scenario) {
        'GatewayPodDelete' {
            $pods = Get-KubeJson @('get', 'pods', '-n', $GatewayNamespace, '-l', "app.kubernetes.io/instance=$GatewayRelease") 'Read gateway pods'
            $podName = @($pods.items | Where-Object { $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] } | Select-Object -First 1).metadata.name
            if ([string]::IsNullOrWhiteSpace($podName)) { throw 'No gateway pod is available for deletion.' }
            $changed = $true
            Invoke-Checked kubectl @('delete', 'pod', $podName, '-n', $GatewayNamespace, '--wait=false') 'Delete one gateway pod' | Out-Null
            Start-Sleep -Seconds 5
        }
        'GatewayRollout' {
            $changed = $true
            Invoke-Checked kubectl @('rollout', 'restart', "deployment/$GatewayRelease", '-n', $GatewayNamespace) 'Restart gateway rollout' | Out-Null
            Wait-Rollout 'deployment' $GatewayRelease $GatewayNamespace
        }
        'GatewayBackendOutage' {
            $deployment = Get-KubeJson @('get', 'deployment', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway Deployment'
            $originalReplicas = [int]$deployment.spec.replicas
            if ($originalReplicas -lt 2) { throw 'GatewayBackendOutage requires at least two configured replicas.' }
            $changed = $true
            Invoke-Checked kubectl @('scale', "deployment/$GatewayRelease", '-n', $GatewayNamespace, '--replicas=0') 'Remove gateway backends' | Out-Null
            Wait-DeploymentAvailableReplicas 0
            $status = Get-ExternalStatus
            if ($status -notin @('502', '503', '504')) { throw "Backend outage returned unexpected HTTP status $status." }
        }
        'TraefikRestart' {
            $changed = $true
            Invoke-Checked kubectl @('rollout', 'restart', "deployment/$TraefikRelease", '-n', $TraefikNamespace) 'Restart Traefik' | Out-Null
            Wait-Rollout 'deployment' $TraefikRelease $TraefikNamespace
        }
        'MetalLbSpeakerRestart' {
            $speakers = Get-KubeJson @('get', 'pods', '-n', $MetalLbNamespace, '-l', $MetalLbSpeakerSelector) 'Read MetalLB speakers'
            $speakerName = @($speakers.items | Where-Object { $_.status.phase -eq 'Running' } | Select-Object -First 1).metadata.name
            if ([string]::IsNullOrWhiteSpace($speakerName)) { throw 'No running MetalLB speaker is available.' }
            $changed = $true
            Invoke-Checked kubectl @('delete', 'pod', $speakerName, '-n', $MetalLbNamespace, '--wait=false') 'Delete one MetalLB speaker' | Out-Null
            Start-Sleep -Seconds 10
        }
        'CertificateRouteMismatch' {
            $route = Get-KubeJson @('get', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway route'
            $originalTlsSecret = [string]$route.spec.tls.secretName
            $changed = $true
            Set-RouteValue '/spec/tls/secretName' 'edge-failure-test-missing' 'Inject missing TLS Secret'
            Start-Sleep -Seconds 5
            try {
                Get-ExternalStatus | Out-Null
                throw 'TLS unexpectedly succeeded with a missing route certificate.'
            }
            catch {
                if ($_.Exception.Message -like 'TLS unexpectedly*') { throw }
            }
        }
        'CertificateRenewal' {
            $certificate = Get-KubeJson @('get', 'certificate', $CertificateName, '-n', $GatewayNamespace) 'Read Certificate metadata'
            $tlsSecretName = [string]$certificate.spec.secretName
            if ([string]::IsNullOrWhiteSpace($tlsSecretName)) { throw 'Certificate has no TLS Secret to renew.' }
            $originalSecretUid = (Invoke-Checked kubectl @('get', 'secret', $tlsSecretName, '-n', $GatewayNamespace, '-o', 'jsonpath={.metadata.uid}') 'Read TLS Secret identity').Trim()
            $changed = $true
            Invoke-Checked kubectl @('delete', 'secret', $tlsSecretName, '-n', $GatewayNamespace, '--wait=true') 'Remove TLS Secret to request renewal' | Out-Null
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
            do {
                $newSecretUid = @(& kubectl get secret $tlsSecretName -n $GatewayNamespace -o 'jsonpath={.metadata.uid}' 2>$null)
                if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($newSecretUid -join '').Trim()) -and ($newSecretUid -join '').Trim() -ne $originalSecretUid) { break }
                Start-Sleep -Seconds 1
            } while ([DateTimeOffset]::UtcNow -lt $deadline)
            if ([string]::IsNullOrWhiteSpace(($newSecretUid -join '').Trim()) -or ($newSecretUid -join '').Trim() -eq $originalSecretUid) { throw 'cert-manager did not publish a replacement TLS Secret within the timeout.' }
            Invoke-Checked kubectl @('wait', 'certificate', $CertificateName, '-n', $GatewayNamespace, '--for=condition=Ready', "--timeout=${TimeoutSeconds}s") 'Wait for renewed Certificate' | Out-Null
        }
        'RouteMismatch' {
            $route = Get-KubeJson @('get', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway route'
            $originalRouteMatch = [string]$route.spec.routes[0].match
            $changed = $true
            Set-RouteValue '/spec/routes/0/match' 'Host(`failure-test.invalid`) && Path(`/unroutable`)' 'Inject invalid route'
            Start-Sleep -Seconds 3
            if ((Get-ExternalStatus) -ne '404') { throw 'Route mismatch did not produce the expected 404.' }
        }
        'NodeDrain' {
            $node = Get-KubeJson @('get', 'node', $NodeName) 'Read target node'
            $unschedulableProperty = $node.spec.PSObject.Properties['unschedulable']
            $nodeWasUnschedulable = $null -ne $unschedulableProperty -and [bool]$unschedulableProperty.Value
            $changed = $true
            Invoke-Checked kubectl @('drain', $NodeName, '--ignore-daemonsets', '--delete-emptydir-data', "--timeout=${TimeoutSeconds}s") 'Drain target node' | Out-Null
        }
    }
}
finally {
    if ($changed) {
        switch ($Scenario) {
            'GatewayBackendOutage' { Invoke-Checked kubectl @('scale', "deployment/$GatewayRelease", '-n', $GatewayNamespace, "--replicas=$originalReplicas") 'Restore gateway replicas' | Out-Null; Wait-Rollout 'deployment' $GatewayRelease $GatewayNamespace }
            'CertificateRouteMismatch' { Set-RouteValue '/spec/tls/secretName' $originalTlsSecret 'Restore TLS Secret reference' }
            'RouteMismatch' { Set-RouteValue '/spec/routes/0/match' $originalRouteMatch 'Restore route match' }
            'NodeDrain' { if (-not $nodeWasUnschedulable) { Invoke-Checked kubectl @('uncordon', $NodeName) 'Uncordon target node' | Out-Null } }
        }
        Start-Sleep -Seconds 5
        try {
            Invoke-EdgeValidationWithRetry | Set-Content -LiteralPath (Join-Path $evidencePath 'recovery.log') -Encoding utf8NoBOM
            $metadata.recovered = $true
        }
        catch {
            $metadata.recovered = $false
            $metadata.recoveryError = $_.Exception.Message
            throw
        }
        finally {
            $metadata.completedUtc = [DateTimeOffset]::UtcNow.ToString('O')
            $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidencePath 'metadata.json') -Encoding utf8NoBOM
        }
    }
}

Write-Host "[PASS] $Scenario recovered successfully. Redacted evidence: $evidencePath"
