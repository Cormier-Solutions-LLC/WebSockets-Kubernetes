<#
.SYNOPSIS
  Runs one reversible failure-recovery test against an approved non-production realtime edge.
.DESCRIPTION
  Binds mutations to an exact kubectl context and labeled namespace, captures redacted
  evidence, injects one bounded failure, restores state in a finally block, and proves
  full replica recovery. Private keys and credential values are never read.
.NOTES
  Version: 1.2.0
  Requires: PowerShell 7.4 or later, kubectl, curl, and an approved non-production cluster.
  Standard: refs/scripts-standard-v4.2.md
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidateSet('GatewayPodDelete', 'GatewayRollout', 'GatewayBackendOutage', 'TraefikRestart', 'MetalLbSpeakerRestart', 'CertificateRenewal', 'CertificateRouteMismatch', 'RouteMismatch', 'NodeDrain')][string]$Scenario,
    [Parameter(Mandatory)][string]$ExpectedContext,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$Environment,
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayNamespace = 'development-realtime',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayRelease = 'development-realtime',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$GatewayHpaName = '',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikNamespace = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikRelease = 'traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$TraefikService = 'traefik',
    [Parameter()][string]$TraefikPodSelector = 'app.kubernetes.io/name=traefik',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateName = 'realtime-cormier-local',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$MetalLbNamespace = 'metallb-system',
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$MetalLbAdvertisement = 'development-traefik',
    [Parameter()][ValidateSet('l2', 'bgp')][string]$MetalLbAdvertisementMode = 'l2',
    [Parameter()][string]$MetalLbSpeakerSelector = 'component=speaker',
    [Parameter()][string]$MetalLbSpeakerNode = '',
    [Parameter()][ValidatePattern('^[a-z0-9.-]+$')][string]$HostName = 'realtime.cormier.local',
    [Parameter()][ValidatePattern('^/[A-Za-z0-9._/-]*$')][string]$Path = '/realtime/ws',
    [Parameter()][ValidatePattern('^$|^https://[a-z0-9.-]+(:[0-9]{1,5})?$')][string]$Origin = '',
    [Parameter()][ValidateRange(1, 65535)][int]$ExternalPort = 443,
    [Parameter()][ValidatePattern('^$|^[0-9a-fA-F:.]+$')][string]$ExternalAddress = '',
    [Parameter()][string]$CertificateAuthorityPath = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateAuthoritySecretName = '',
    [Parameter()][ValidatePattern('^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$CertificateAuthoritySecretNamespace = '',
    [Parameter()][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$CertificateAuthoritySecretKey = 'tls.crt',
    [Parameter()][ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$TicketEnvironmentVariable = 'REALTIME_EDGE_TICKET',
    [Parameter()][string]$TicketRefreshCommand = '',
    [Parameter()][ValidatePattern('^$|^[0-9a-fA-F:.]+$')][string]$ExpectedClientIp = '',
    [Parameter()][ValidateRange(0, 65535)][int]$GatewayMetricsPort = 0,
    [Parameter()][string]$NodeName = '',
    [Parameter()][switch]$AllowNodeDrain,
    [Parameter()][ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
    [Parameter()][ValidateRange(5, 300)][int]$HeartbeatSeconds = 15,
    [Parameter()][string]$EvidenceDirectory = '.evidence/edge'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$changed = $false
$duringCaptured = $false
$originalReplicas = 0
$originalRouteMatch = ''
$originalTlsSecret = ''
$replacementCertificateName = ''
$replacementSecretName = ''
$nodeWasUnschedulable = $false
$continuityProcess = $null
$continuityReadyPath = ''
$continuityStopPath = ''
$originalHpa = $null
$hpaRemoved = $false
$lockAcquired = $false
$failureLockName = ''
$externalAuthority = if ($ExternalPort -eq 443) { $HostName } else { "${HostName}:$ExternalPort" }
$effectiveOrigin = if ([string]::IsNullOrWhiteSpace($Origin)) { "https://$externalAuthority" } else { $Origin }
$effectiveGatewayHpaName = if ([string]::IsNullOrWhiteSpace($GatewayHpaName)) { $GatewayRelease } else { $GatewayHpaName }

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Description) {
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $output = @(& $File @Arguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        $stderr = [IO.File]::ReadAllText($stderrPath).Trim()
        if ($exitCode -ne 0) { throw "$Description failed with exit code $exitCode." }
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Warning $stderr }
        return ($output -join [Environment]::NewLine)
    }
    finally { Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue }
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
        $availableReplicas = if ($null -eq $deployment.status.PSObject.Properties['availableReplicas']) { 0 } else { [int]$deployment.status.availableReplicas }
        if ($availableReplicas -eq $ExpectedReplicas) { return }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Gateway did not reach $ExpectedReplicas available replicas within $TimeoutSeconds seconds."
}

function Wait-DeploymentFullyRecovered([string]$Name, [string]$Namespace) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $deployment = Get-KubeJson @('get', 'deployment', $Name, '-n', $Namespace) "Read $Name recovery state"
        $desired = [int]$deployment.spec.replicas
        $observed = if ($null -eq $deployment.status.PSObject.Properties['observedGeneration']) { 0 } else { [long]$deployment.status.observedGeneration }
        $available = if ($null -eq $deployment.status.PSObject.Properties['availableReplicas']) { 0 } else { [int]$deployment.status.availableReplicas }
        $ready = if ($null -eq $deployment.status.PSObject.Properties['readyReplicas']) { 0 } else { [int]$deployment.status.readyReplicas }
        $updated = if ($null -eq $deployment.status.PSObject.Properties['updatedReplicas']) { 0 } else { [int]$deployment.status.updatedReplicas }
        $selector = @($deployment.spec.selector.matchLabels.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
        $pods = Get-KubeJson @('get', 'pods', '-n', $Namespace, '-l', $selector) "Read $Name recovery pods"
        $terminatingPods = @($pods.items | Where-Object { $null -ne $_.metadata.PSObject.Properties['deletionTimestamp'] }).Count
        $readyPods = @($pods.items | Where-Object {
            $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] -and $_.status.phase -eq 'Running' -and
            @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
        }).Count
        if ($observed -ge [long]$deployment.metadata.generation -and $available -eq $desired -and $ready -eq $desired -and $updated -eq $desired -and $readyPods -eq $desired -and $terminatingPods -eq 0) { return }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "$Namespace deployment/$Name did not fully recover all configured replicas within $TimeoutSeconds seconds."
}

function Wait-MetalLbSpeakerRecovered([string]$NodeName) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $speakers = Get-KubeJson @('get', 'pods', '-n', $MetalLbNamespace, '-l', $MetalLbSpeakerSelector) 'Read MetalLB speaker recovery'
        $readySpeaker = @($speakers.items | Where-Object {
            $_.spec.nodeName -eq $NodeName -and $_.status.phase -eq 'Running' -and
            @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
        })
        $advertisementReady = $true
        if ($MetalLbAdvertisementMode -eq 'l2') {
            $statuses = Get-KubeJson @('get', 'servicel2status', '-n', $MetalLbNamespace) 'Read recovered MetalLB L2 announcer status'
            $advertisementReady = @($statuses.items | Where-Object { $_.status.serviceName -eq $TraefikService -and $_.status.serviceNamespace -eq $TraefikNamespace }).Count -eq 1
        }
        if ($readySpeaker.Count -ge 1 -and $advertisementReady) { return }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "MetalLB speaker on node $NodeName did not recover within $TimeoutSeconds seconds."
}

function Set-RouteValue([string]$JsonPointer, [string]$Value, [string]$Description) {
    $patch = @{ op = 'replace'; path = $JsonPointer; value = $Value } | ConvertTo-Json -Compress -AsArray
    Invoke-Checked kubectl @('patch', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace, '--type=json', '-p', $patch) $Description | Out-Null
}

function Get-EdgeValidationArguments([string]$CertificateOverride = '', [string]$AuthoritySecretOverride = '', [string]$AuthoritySecretKeyOverride = '', [string]$AuthoritySecretNamespaceOverride = '') {
    $effectiveCertificate = if ([string]::IsNullOrWhiteSpace($CertificateOverride)) { $CertificateName } else { $CertificateOverride }
    $effectiveAuthoritySecret = if ([string]::IsNullOrWhiteSpace($AuthoritySecretOverride)) { $CertificateAuthoritySecretName } else { $AuthoritySecretOverride }
    $effectiveAuthoritySecretKey = if ([string]::IsNullOrWhiteSpace($AuthoritySecretKeyOverride)) { $CertificateAuthoritySecretKey } else { $AuthoritySecretKeyOverride }
    $effectiveAuthoritySecretNamespace = if ([string]::IsNullOrWhiteSpace($AuthoritySecretNamespaceOverride)) { $CertificateAuthoritySecretNamespace } else { $AuthoritySecretNamespaceOverride }
    $arguments = @(
        '-NoProfile', '-File', (Join-Path $PSScriptRoot 'Test-RealtimeEdge.ps1'),
        '-ExpectedContext', $ExpectedContext, '-GatewayNamespace', $GatewayNamespace,
        '-GatewayRelease', $GatewayRelease, '-TraefikNamespace', $TraefikNamespace,
        '-TraefikService', $TraefikService, '-TraefikRelease', $TraefikRelease,
        '-TraefikPodSelector', $TraefikPodSelector, '-CertificateName', $effectiveCertificate,
        '-MetalLbNamespace', $MetalLbNamespace, '-MetalLbAdvertisement', $MetalLbAdvertisement,
        '-MetalLbAdvertisementMode', $MetalLbAdvertisementMode, '-MetalLbSpeakerSelector', $MetalLbSpeakerSelector,
        '-TicketEnvironmentVariable', $TicketEnvironmentVariable, '-GatewayMetricsPort', $GatewayMetricsPort,
        '-HostName', $HostName, '-Path', $Path, '-Origin', $effectiveOrigin,
        '-ExternalPort', $ExternalPort, '-TimeoutSeconds', $TimeoutSeconds, '-HeartbeatSeconds', $HeartbeatSeconds
    )
    if (-not [string]::IsNullOrWhiteSpace($CertificateAuthorityPath)) { $arguments += @('-CertificateAuthorityPath', $CertificateAuthorityPath) }
    if (-not [string]::IsNullOrWhiteSpace($effectiveAuthoritySecret)) {
        $arguments += @('-CertificateAuthoritySecretName', $effectiveAuthoritySecret, '-CertificateAuthoritySecretKey', $effectiveAuthoritySecretKey)
        if (-not [string]::IsNullOrWhiteSpace($effectiveAuthoritySecretNamespace)) { $arguments += @('-CertificateAuthoritySecretNamespace', $effectiveAuthoritySecretNamespace) }
    }
    if (-not [string]::IsNullOrWhiteSpace($ExternalAddress)) { $arguments += @('-ExternalAddress', $ExternalAddress) }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedClientIp)) { $arguments += @('-ExpectedClientIp', $ExpectedClientIp) }
    if (-not [string]::IsNullOrWhiteSpace($TicketRefreshCommand)) { $arguments += @('-TicketRefreshCommand', $TicketRefreshCommand) }
    return $arguments
}

function Invoke-EdgeValidation([string]$CertificateOverride = '', [string]$AuthoritySecretOverride = '', [string]$AuthoritySecretKeyOverride = '', [string]$AuthoritySecretNamespaceOverride = '') {
    $ticket = [Environment]::GetEnvironmentVariable($TicketEnvironmentVariable)
    try {
        [Environment]::SetEnvironmentVariable($TicketEnvironmentVariable, $null)
        return Invoke-Checked pwsh (Get-EdgeValidationArguments $CertificateOverride $AuthoritySecretOverride $AuthoritySecretKeyOverride $AuthoritySecretNamespaceOverride) 'Run external edge validation'
    }
    finally { [Environment]::SetEnvironmentVariable($TicketEnvironmentVariable, $ticket) }
}

function Invoke-EdgeValidationWithRetry([string]$CertificateOverride = '', [string]$AuthoritySecretOverride = '', [string]$AuthoritySecretKeyOverride = '', [string]$AuthoritySecretNamespaceOverride = '') {
    $lastError = $null
    foreach ($attempt in 1..3) {
        try { return Invoke-EdgeValidation $CertificateOverride $AuthoritySecretOverride $AuthoritySecretKeyOverride $AuthoritySecretNamespaceOverride }
        catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
        }
    }
    throw $lastError
}

function Start-ContinuityProbe {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($TicketEnvironmentVariable))) {
        throw "$TicketEnvironmentVariable must contain a fresh single-use ticket for an authenticated continuity scenario. Baseline and recovery checks intentionally do not consume it."
    }
    $script:continuityReadyPath = Join-Path $evidencePath 'continuity-ready.marker'
    $script:continuityStopPath = Join-Path $evidencePath 'continuity-stop.marker'
    $arguments = Get-EdgeValidationArguments
    $arguments += @('-LongConnectionSeconds', $TimeoutSeconds, '-ConnectionReadyFile', $continuityReadyPath, '-ConnectionStopFile', $continuityStopPath)
    if ($Scenario -eq 'GatewayRollout') { $arguments += '-RequireReconnect' }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $arguments) { $startInfo.ArgumentList.Add([string]$argument) }
    $script:continuityProcess = [Diagnostics.Process]::Start($startInfo)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $continuityReadyPath)) {
        if ($continuityProcess.HasExited) {
            $details = $continuityProcess.StandardOutput.ReadToEnd() + $continuityProcess.StandardError.ReadToEnd()
            throw "Continuity probe exited before establishing WSS: $details"
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Timed out waiting for the authenticated continuity connection.' }
        Start-Sleep -Milliseconds 200
    }
}

function Complete-ContinuityProbe {
    if ($null -eq $continuityProcess) { return }
    [IO.File]::WriteAllText($continuityStopPath, [DateTimeOffset]::UtcNow.ToString('O'))
    if (-not $continuityProcess.WaitForExit($TimeoutSeconds * 1000)) {
        $continuityProcess.Kill($true)
        throw 'Authenticated continuity probe did not complete within the timeout.'
    }
    $output = $continuityProcess.StandardOutput.ReadToEnd()
    $errors = $continuityProcess.StandardError.ReadToEnd()
    $exitCode = $continuityProcess.ExitCode
    $continuityProcess.Dispose()
    $script:continuityProcess = $null
    ($output + $errors) | Set-Content -LiteralPath (Join-Path $evidencePath 'during-failure.log') -Encoding utf8NoBOM
    Remove-Item -LiteralPath $continuityReadyPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $continuityStopPath -Force -ErrorAction SilentlyContinue
    if ($exitCode -ne 0) { throw "Authenticated continuity probe failed with exit code $exitCode." }
    $script:duringCaptured = $true
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
            $authorityNamespace = if ([string]::IsNullOrWhiteSpace($CertificateAuthoritySecretNamespace)) { $GatewayNamespace } else { $CertificateAuthoritySecretNamespace }
            $jsonPathKey = $CertificateAuthoritySecretKey -replace '\.', '\.'
            $encodedCertificate = Invoke-Checked kubectl @('get', 'secret', $CertificateAuthoritySecretName, '-n', $authorityNamespace, '-o', "jsonpath={.data.$jsonPathKey}") 'Read configured public CA certificate'
            if ([string]::IsNullOrWhiteSpace($encodedCertificate)) { throw "CA Secret $CertificateAuthoritySecretName does not contain key $CertificateAuthoritySecretKey." }
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

function Assert-ApprovedMetadata([object]$Metadata, [string]$TargetDescription) {
    if ($null -eq $Metadata.PSObject.Properties['labels'] -or $null -eq $Metadata.labels) { throw "SAFETY STOP: $TargetDescription has no approval labels." }
    $environmentLabel = $Metadata.labels.PSObject.Properties['cormier.io/environment']
    $approvalLabel = $Metadata.labels.PSObject.Properties['cormier.io/failure-testing']
    $targetEnvironment = if ($null -eq $environmentLabel) { '' } else { [string]$environmentLabel.Value }
    $failureApproval = if ($null -eq $approvalLabel) { '' } else { [string]$approvalLabel.Value }
    if ($targetEnvironment -ne $Environment -or $failureApproval -ne 'approved') {
        throw "SAFETY STOP: $TargetDescription must have cormier.io/environment=$Environment and cormier.io/failure-testing=approved."
    }
}

function Restore-GatewayHpa {
    if (-not $hpaRemoved -or $null -eq $originalHpa) { return }
    $metadata = [ordered]@{ name = [string]$originalHpa.metadata.name; namespace = $GatewayNamespace }
    $labelsProperty = $originalHpa.metadata.PSObject.Properties['labels']
    if ($null -ne $labelsProperty) { $metadata.labels = $labelsProperty.Value }
    $manifest = [ordered]@{
        apiVersion = [string]$originalHpa.apiVersion
        kind = 'HorizontalPodAutoscaler'
        metadata = $metadata
        spec = $originalHpa.spec
    }
    $manifestPath = [IO.Path]::GetTempFileName()
    try {
        $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
        Invoke-Checked kubectl @('apply', '-f', $manifestPath) 'Restore gateway HPA' | Out-Null
    }
    finally { Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue }
}

function Acquire-FailureLock {
    $identity = "$ExpectedContext|$GatewayNamespace|$GatewayRelease|$TraefikNamespace|$TraefikRelease|$MetalLbNamespace"
    $hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity))
    $suffix = ([Convert]::ToHexString($hashBytes)).ToLowerInvariant().Substring(0, 16)
    $script:failureLockName = "realtime-failure-$suffix"
    try {
        Invoke-Checked kubectl @('create', 'configmap', $failureLockName, '-n', $GatewayNamespace, "--from-literal=holder=$([Guid]::NewGuid().ToString('N'))") 'Acquire exclusive edge failure-test lock' | Out-Null
        $script:lockAcquired = $true
    }
    catch { throw "CONCURRENT: another failure test holds lock configmap/$failureLockName in namespace $GatewayNamespace." }
}

function Release-FailureLock {
    if (-not $lockAcquired) { return }
    Invoke-Checked kubectl @('delete', 'configmap', $failureLockName, '-n', $GatewayNamespace, '--ignore-not-found=true') 'Release edge failure-test lock' | Out-Null
    $script:lockAcquired = $false
}

foreach ($command in @('kubectl', 'curl', 'pwsh')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "MISSING: $command is required." }
}
if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'UNSUPPORTED: PowerShell 7.4 or later is required.' }
$context = (Invoke-Checked kubectl @('config', 'current-context') 'Read Kubernetes context').Trim()
if ($context -ne $ExpectedContext) { throw "TARGET MISMATCH: expected '$ExpectedContext', detected '$context'." }
if ($Environment -match '^(prod|production)$') { throw 'SAFETY STOP: failure tests cannot target an environment named prod or production.' }
$gatewayNamespaceMetadata = Get-KubeJson @('get', 'namespace', $GatewayNamespace) 'Read gateway namespace safety labels'
Assert-ApprovedMetadata $gatewayNamespaceMetadata.metadata "namespace $GatewayNamespace"
if ($Scenario -in @('TraefikRestart', 'NodeDrain')) {
    $traefikNamespaceMetadata = Get-KubeJson @('get', 'namespace', $TraefikNamespace) 'Read Traefik namespace safety labels'
    Assert-ApprovedMetadata $traefikNamespaceMetadata.metadata "namespace $TraefikNamespace"
}
if ($Scenario -eq 'MetalLbSpeakerRestart') {
    $metalLbNamespaceMetadata = Get-KubeJson @('get', 'namespace', $MetalLbNamespace) 'Read MetalLB namespace safety labels'
    Assert-ApprovedMetadata $metalLbNamespaceMetadata.metadata "namespace $MetalLbNamespace"
}
if ($Scenario -eq 'NodeDrain' -and (-not $AllowNodeDrain -or [string]::IsNullOrWhiteSpace($NodeName))) {
    throw 'NodeDrain requires both -AllowNodeDrain and an explicit -NodeName.'
}
if ($Scenario -eq 'NodeDrain') {
    $approvedNode = Get-KubeJson @('get', 'node', $NodeName) 'Read node safety labels'
    Assert-ApprovedMetadata $approvedNode.metadata "node $NodeName"
    $gatewayPods = Get-KubeJson @('get', 'pods', '-n', $GatewayNamespace, '-l', "app.kubernetes.io/instance=$GatewayRelease") 'Read selected gateway nodes'
    $traefikPods = Get-KubeJson @('get', 'pods', '-n', $TraefikNamespace, '-l', $TraefikPodSelector) 'Read selected Traefik nodes'
    $selectedNodes = @(@($gatewayPods.items) + @($traefikPods.items) | ForEach-Object { $_.spec.nodeName } | Where-Object { $_ } | Sort-Object -Unique)
    if ($selectedNodes -notcontains $NodeName) { throw "SAFETY STOP: node $NodeName does not host a pod from the selected gateway or Traefik workload." }
}
if ($Scenario -eq 'MetalLbSpeakerRestart' -and $MetalLbAdvertisementMode -eq 'bgp' -and [string]::IsNullOrWhiteSpace($MetalLbSpeakerNode)) {
    throw 'BGP MetalLbSpeakerRestart requires an explicit -MetalLbSpeakerNode.'
}
if ($Scenario -eq 'GatewayRollout' -and [string]::IsNullOrWhiteSpace($TicketRefreshCommand)) {
    throw 'GatewayRollout requires TicketRefreshCommand so an expected service-restart close can reconnect with a fresh single-use ticket.'
}

$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$evidencePath = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) "$Environment-$Scenario-$timestamp"
[IO.Directory]::CreateDirectory($evidencePath) | Out-Null
$metadata = [ordered]@{ scenario = $Scenario; environment = $Environment; context = $context; gatewayNamespace = $GatewayNamespace; startedUtc = [DateTimeOffset]::UtcNow.ToString('O'); host = $HostName; path = $Path }
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidencePath 'metadata.json') -Encoding utf8NoBOM

try {
    Invoke-EdgeValidationWithRetry | Set-Content -LiteralPath (Join-Path $evidencePath 'baseline.log') -Encoding utf8NoBOM
    if (-not $PSCmdlet.ShouldProcess("$Environment on $ExpectedContext", "Inject $Scenario and automatically restore it")) { return }
    Acquire-FailureLock
    $continuityScenarios = @('GatewayPodDelete', 'GatewayRollout', 'TraefikRestart', 'MetalLbSpeakerRestart', 'CertificateRenewal', 'NodeDrain')

    switch ($Scenario) {
        'GatewayPodDelete' {
            $pods = Get-KubeJson @('get', 'pods', '-n', $GatewayNamespace, '-l', "app.kubernetes.io/instance=$GatewayRelease") 'Read gateway pods'
            $podName = @($pods.items | Where-Object {
                $null -eq $_.metadata.PSObject.Properties['deletionTimestamp'] -and $_.status.phase -eq 'Running' -and
                @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
            } | Select-Object -First 1).metadata.name
            if ([string]::IsNullOrWhiteSpace($podName)) { throw 'No gateway pod is available for deletion.' }
            Start-ContinuityProbe
            $changed = $true
            Invoke-Checked kubectl @('delete', 'pod', $podName, '-n', $GatewayNamespace, '--wait=false') 'Delete one gateway pod' | Out-Null
            Wait-DeploymentFullyRecovered $GatewayRelease $GatewayNamespace
        }
        'GatewayRollout' {
            Start-ContinuityProbe
            $changed = $true
            Invoke-Checked kubectl @('rollout', 'restart', "deployment/$GatewayRelease", '-n', $GatewayNamespace) 'Restart gateway rollout' | Out-Null
            Wait-Rollout 'deployment' $GatewayRelease $GatewayNamespace
            Wait-DeploymentFullyRecovered $GatewayRelease $GatewayNamespace
        }
        'GatewayBackendOutage' {
            $deployment = Get-KubeJson @('get', 'deployment', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway Deployment'
            $originalReplicas = [int]$deployment.spec.replicas
            if ($originalReplicas -lt 2) { throw 'GatewayBackendOutage requires at least two configured replicas.' }
            $changed = $true
            $hpaOutput = Invoke-Checked kubectl @('get', 'hpa', $effectiveGatewayHpaName, '-n', $GatewayNamespace, '--ignore-not-found=true', '-o', 'json') 'Read gateway HPA'
            if (-not [string]::IsNullOrWhiteSpace($hpaOutput)) {
                $originalHpa = $hpaOutput | ConvertFrom-Json
                Invoke-Checked kubectl @('delete', 'hpa', $effectiveGatewayHpaName, '-n', $GatewayNamespace, '--wait=true') 'Suspend gateway HPA for backend outage' | Out-Null
                $hpaRemoved = $true
            }
            Invoke-Checked kubectl @('scale', "deployment/$GatewayRelease", '-n', $GatewayNamespace, '--replicas=0') 'Remove gateway backends' | Out-Null
            Wait-DeploymentAvailableReplicas 0
            $status = Get-ExternalStatus
            if ($status -notin @('502', '503', '504')) { throw "Backend outage returned unexpected HTTP status $status." }
        }
        'TraefikRestart' {
            Start-ContinuityProbe
            $changed = $true
            Invoke-Checked kubectl @('rollout', 'restart', "deployment/$TraefikRelease", '-n', $TraefikNamespace) 'Restart Traefik' | Out-Null
            Wait-Rollout 'deployment' $TraefikRelease $TraefikNamespace
            Wait-DeploymentFullyRecovered $TraefikRelease $TraefikNamespace
        }
        'MetalLbSpeakerRestart' {
            $speakerNode = $MetalLbSpeakerNode
            if ($MetalLbAdvertisementMode -eq 'l2') {
                $statuses = Get-KubeJson @('get', 'servicel2status', '-n', $MetalLbNamespace) 'Read MetalLB L2 announcer status'
                $matchingStatuses = @($statuses.items | Where-Object { $_.status.serviceName -eq $TraefikService -and $_.status.serviceNamespace -eq $TraefikNamespace })
                if ($matchingStatuses.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$matchingStatuses[0].status.node)) { throw 'MetalLB did not report exactly one L2 announcer for the Traefik service.' }
                $speakerNode = [string]$matchingStatuses[0].status.node
            }
            $speakers = Get-KubeJson @('get', 'pods', '-n', $MetalLbNamespace, '-l', $MetalLbSpeakerSelector) 'Read MetalLB speakers'
            $speakerName = @($speakers.items | Where-Object { $_.status.phase -eq 'Running' -and $_.spec.nodeName -eq $speakerNode } | Select-Object -First 1).metadata.name
            if ([string]::IsNullOrWhiteSpace($speakerName)) { throw "No running MetalLB speaker is available on announcing node $speakerNode." }
            Start-ContinuityProbe
            $changed = $true
            Invoke-Checked kubectl @('delete', 'pod', $speakerName, '-n', $MetalLbNamespace, '--wait=false') 'Delete active MetalLB speaker' | Out-Null
            Wait-MetalLbSpeakerRecovered $speakerNode
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
                if ($_.Exception.Message -notlike '*exit code 60.*') { throw }
            }
        }
        'CertificateRenewal' {
            $certificate = Get-KubeJson @('get', 'certificate', $CertificateName, '-n', $GatewayNamespace) 'Read Certificate metadata'
            $route = Get-KubeJson @('get', 'ingressroute', $GatewayRelease, '-n', $GatewayNamespace) 'Read gateway route'
            $originalTlsSecret = [string]$route.spec.tls.secretName
            $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
            $replacementCertificateName = "edge-renewal-$suffix"
            $replacementSecretName = "edge-renewal-tls-$suffix"
            $replacement = [ordered]@{
                apiVersion = [string]$certificate.apiVersion
                kind = 'Certificate'
                metadata = [ordered]@{ name = $replacementCertificateName; namespace = $GatewayNamespace; labels = @{ 'cormier.io/failure-test' = 'certificate-renewal' } }
                spec = $certificate.spec
            }
            $replacement.spec.secretName = $replacementSecretName
            $manifestPath = [IO.Path]::GetTempFileName()
            try {
                $replacement | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
                $changed = $true
                Invoke-Checked kubectl @('apply', '-f', $manifestPath) 'Create parallel replacement Certificate' | Out-Null
            }
            finally { Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue }
            Invoke-Checked kubectl @('wait', 'certificate', $replacementCertificateName, '-n', $GatewayNamespace, '--for=condition=Ready', "--timeout=${TimeoutSeconds}s") 'Wait for replacement TLS Secret' | Out-Null
            Start-ContinuityProbe
            Set-RouteValue '/spec/tls/secretName' $replacementSecretName 'Switch route to replacement TLS Secret'
            $replacementAuthoritySecret = if ([string]::IsNullOrWhiteSpace($CertificateAuthorityPath) -and $CertificateAuthoritySecretName -eq $originalTlsSecret) { $replacementSecretName } else { '' }
            $replacementAuthorityKey = if ([string]::IsNullOrWhiteSpace($replacementAuthoritySecret)) { '' } else { 'tls.crt' }
            $replacementAuthorityNamespace = if ([string]::IsNullOrWhiteSpace($replacementAuthoritySecret)) { '' } else { $GatewayNamespace }
            Invoke-EdgeValidationWithRetry $replacementCertificateName $replacementAuthoritySecret $replacementAuthorityKey $replacementAuthorityNamespace | Set-Content -LiteralPath (Join-Path $evidencePath 'replacement-certificate.log') -Encoding utf8NoBOM
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
            Start-ContinuityProbe
            $changed = $true
            Invoke-Checked kubectl @('drain', $NodeName, '--ignore-daemonsets', '--delete-emptydir-data', "--timeout=${TimeoutSeconds}s") 'Drain target node' | Out-Null
        }
    }

    if ($Scenario -in $continuityScenarios) { Complete-ContinuityProbe }
    if (-not $duringCaptured -and $Scenario -in $continuityScenarios) {
        throw "$Scenario did not capture continuity evidence during the active failure."
    }
}
finally {
    try {
      if ($changed) {
        switch ($Scenario) {
            'GatewayBackendOutage' {
                Invoke-Checked kubectl @('scale', "deployment/$GatewayRelease", '-n', $GatewayNamespace, "--replicas=$originalReplicas") 'Restore gateway replicas' | Out-Null
                Restore-GatewayHpa
            }
            'CertificateRouteMismatch' { Set-RouteValue '/spec/tls/secretName' $originalTlsSecret 'Restore TLS Secret reference' }
            'CertificateRenewal' {
                if (-not [string]::IsNullOrWhiteSpace($originalTlsSecret)) { Set-RouteValue '/spec/tls/secretName' $originalTlsSecret 'Restore TLS Secret reference' }
                if (-not [string]::IsNullOrWhiteSpace($replacementCertificateName)) { Invoke-Checked kubectl @('delete', 'certificate', $replacementCertificateName, '-n', $GatewayNamespace, '--ignore-not-found=true') 'Remove replacement Certificate' | Out-Null }
                if (-not [string]::IsNullOrWhiteSpace($replacementSecretName)) { Invoke-Checked kubectl @('delete', 'secret', $replacementSecretName, '-n', $GatewayNamespace, '--ignore-not-found=true') 'Remove replacement TLS Secret' | Out-Null }
            }
            'RouteMismatch' { Set-RouteValue '/spec/routes/0/match' $originalRouteMatch 'Restore route match' }
            'NodeDrain' { if (-not $nodeWasUnschedulable) { Invoke-Checked kubectl @('uncordon', $NodeName) 'Uncordon target node' | Out-Null } }
        }
        if ($null -ne $continuityProcess) { Complete-ContinuityProbe }
        Wait-DeploymentFullyRecovered $GatewayRelease $GatewayNamespace
        Wait-DeploymentFullyRecovered $TraefikRelease $TraefikNamespace
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
      elseif ($null -ne $continuityProcess) {
        if (-not $continuityProcess.HasExited) { $continuityProcess.Kill($true) }
        $continuityProcess.Dispose()
        Remove-Item -LiteralPath $continuityReadyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $continuityStopPath -Force -ErrorAction SilentlyContinue
      }
    }
    finally { Release-FailureLock }
}

Write-Host "[PASS] $Scenario recovered successfully. Redacted evidence: $evidencePath"
