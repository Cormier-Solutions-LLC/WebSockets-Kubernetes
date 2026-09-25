<#
.SYNOPSIS
  Validates, deploys, rolls back, backs up, restores, or removes Cormier realtime.
.DESCRIPTION
  Idempotent PowerShell 7 lifecycle automation governed by Scripts Standard 4.2.
  Captures current Helm values/resources before mutation, uses bounded waits, and
  writes redacted logs retained for seven days. It never creates credentials.
.PARAMETER Action
  Validate, Plan, Deploy, Rollback, Remove, BackupRedis, or RestoreRedis.
.PARAMETER Environment
  Lowercase environment identifier of at most 10 characters.
.PARAMETER Application
  Lowercase application identifier. Release/namespace is environment-application.
.PARAMETER ValuesFile
  Environment-specific gateway values file.
.PARAMETER ImageRepository
  Full registry/repository override. Defaults to the bootstrap naming manifest.
.PARAMETER ManagedRedis
  Install/upgrade the pinned managed Redis chart before the gateway.
.PARAMETER ExpectedContext
  Required kubectl context; prevents accidental cross-cluster changes.
.PARAMETER Force
  Required for Remove and RestoreRedis.
.NOTES
  Version: 1.0.3-beta
  Requires: PowerShell 7, Helm 4.2.0, kubectl, Git, a reachable Kubernetes cluster
  Standard: refs/scripts-standard-v4.2.md
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Validate','Plan','Deploy','Rollback','Remove','BackupRedis','RestoreRedis')][string]$Action,
    [Parameter(Mandatory)][ValidateLength(1,10)][ValidatePattern('^[a-z0-9]+$')][string]$Environment,
    [Parameter()][ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Application = 'realtime',
    [Parameter()][string]$ValuesFile,
    [Parameter()][ValidatePattern('^[a-z0-9.-]+(?::[0-9]+)?(?:/[a-z0-9._-]+)+$')][string]$ImageRepository,
    [Parameter()][switch]$ManagedRedis,
    [Parameter()][ValidatePattern('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')][string]$RedisSecretName,
    [Parameter()][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$RedisUsername = 'realtime',
    [Parameter()][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$RedisPasswordKey = 'realtime',
    [Parameter()][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$RedisAdminPasswordKey = 'redis-password',
    [Parameter()][ValidatePattern('^[a-zA-Z0-9:_-]+$')][string]$RedisInstancePrefix,
    [Parameter(Mandatory)][string]$ExpectedContext,
    [Parameter()][ValidateRange(60,1800)][int]$TimeoutSeconds = 300,
    [Parameter()][string]$BackupFile,
    [Parameter()][switch]$Force,
    [Parameter()][switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$namingPath = Join-Path $root '.bootstrap/naming.json'
$naming = if (Test-Path -LiteralPath $namingPath -PathType Leaf) {
    Get-Content -LiteralPath $namingPath -Raw | ConvertFrom-Json
}
else {
    $null
}
if (-not $PSBoundParameters.ContainsKey('Application') -and $null -ne $naming) {
    $configuredApplication = [string]$naming.kubernetesApplication
    if ($configuredApplication.Length -gt 63 -or $configuredApplication -notmatch '^[a-z0-9][a-z0-9-]*$') {
        throw "INVALID: kubernetesApplication in $namingPath is not a valid DNS label."
    }
    $Application = $configuredApplication
}
$target = "$Environment-$Application"
$namespace = $target
$redisRelease = "$target-redis"
if ($target.Length -gt 53) {
    throw "INVALID: Helm release '$target' exceeds the 53-character limit. Shorten Environment or Application."
}
if ($ManagedRedis -and $redisRelease.Length -gt 53) {
    throw "INVALID: managed Redis Helm release '$redisRelease' exceeds the 53-character limit. Shorten Environment or Application."
}
if (-not $RedisSecretName) { $RedisSecretName = "$target-redis" }
if (-not $RedisInstancePrefix) {
    $RedisInstancePrefix = if ($null -ne $naming -and $Application -eq [string]$naming.kubernetesApplication) {
        # The shared naming manifest already contains the complete environment-
        # and suffix-qualified Redis key/channel prefix.
        [string]$naming.redisInstancePrefix
    }
    else {
        "${Environment}:$Application"
    }
}
if ([string]::IsNullOrWhiteSpace($RedisInstancePrefix) -or $RedisInstancePrefix -notmatch '^[a-zA-Z0-9:_-]+$') {
    throw "INVALID: Redis instance prefix is empty or contains unsupported characters."
}
if (-not $ImageRepository -and $null -ne $naming -and $Application -eq [string]$naming.kubernetesApplication) {
    $ImageRepository = [string]$naming.imageRepository
}
if ($ImageRepository -and $ImageRepository -notmatch '^[a-z0-9.-]+(?::[0-9]+)?(?:/[a-z0-9._-]+)+$') {
    throw 'INVALID: image repository must include a valid registry and repository path.'
}
$chart = Join-Path $root 'helm/realtime-gateway'
$redisValues = Join-Path $root 'cluster/redis/managed-values.yaml'
$logDir = Join-Path $root '.logs'
$backupDir = Join-Path $root ".backups/$target"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDir "Deploy-Realtime-$target-$stamp.log"
$lockPath = Join-Path ([IO.Path]::GetTempPath()) "cormier-realtime-$target.lock"
$lockStream = $null
$summary = [ordered]@{ Created=0; Updated=0; Unchanged=0; Skipped=0; Errors=0 }
[IO.Directory]::CreateDirectory($logDir) | Out-Null

function Write-Log([ValidateSet('INFO','PASS','WARN','ERROR','FATAL')][string]$Level,[string]$Message) {
    $safe = $Message -replace '(?i)((password|token|secret|authorization|cookie)\s*[:=]\s*)\S+', '$1[REDACTED]'
    "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$Level,$safe | Tee-Object -FilePath $logPath -Append
}
function Phase([string]$Name) { Write-Log INFO ('='*72); Write-Log INFO "PHASE - $Name" }
function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "MISSING: $Name is required." }
    Write-Log PASS "READY: $Name"
}
function Invoke-Tool([string]$File,[string[]]$Arguments,[string]$Description,[switch]$Capture) {
    Write-Log INFO "RUNNING: $Description"
    $output = @(& $File @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE. $($output -join ' ')" }
    if ($Capture) { return ($output -join [Environment]::NewLine) }
    $output | ForEach-Object { if ($_){ Write-Log INFO ([string]$_) } }
    Write-Log PASS "COMPLETED: $Description"
}
function Assert-Target {
    Assert-Command helm; Assert-Command kubectl; Assert-Command git
    $helmVersion = Invoke-Tool helm @('version','--short') 'Read Helm version' -Capture
    if ($helmVersion -notmatch '^v4\.2\.0') { throw "UNSUPPORTED: Helm 4.2.0 is required; detected $helmVersion" }
    $context = Invoke-Tool kubectl @('config','current-context') 'Read Kubernetes context' -Capture
    if ($context.Trim() -ne $ExpectedContext) { throw "TARGET MISMATCH: expected context '$ExpectedContext', detected '$($context.Trim())'." }
    Invoke-Tool kubectl @('cluster-info','--request-timeout=15s') 'Reach Kubernetes API'
    foreach ($verbResource in @('get:namespaces','create:deployments.apps','patch:deployments.apps','delete:deployments.apps','get:secrets')) {
        $parts = $verbResource.Split(':')
        $allowed = Invoke-Tool kubectl @('auth','can-i',$parts[0],$parts[1],'-n',$namespace) "Check RBAC $verbResource" -Capture
        if ($allowed.Trim() -ne 'yes') { throw "FORBIDDEN: missing $verbResource in $namespace." }
    }
    Invoke-Tool helm @('lint',$chart,'--strict') 'Lint gateway chart'
    if ($ValuesFile) {
        $script:ValuesFile = [IO.Path]::GetFullPath($ValuesFile)
        if (-not (Test-Path -LiteralPath $script:ValuesFile -PathType Leaf)) { throw "MISSING: values file $ValuesFile" }
    }
    $secretName = Invoke-Tool kubectl @('get','secret',$RedisSecretName,'-n',$namespace,'--ignore-not-found','-o','name') 'Check Redis credential Secret' -Capture
    if ($Action -notin @('Validate','Plan') -and -not $secretName) {
        throw "MISSING: Secret '$RedisSecretName' in namespace '$namespace'."
    }
    if ($secretName) {
        $keys = Invoke-Tool kubectl @('get','secret',$RedisSecretName,'-n',$namespace,'-o','go-template={{range $key, $_ := .data}}{{$key}}{{"\n"}}{{end}}') 'Validate Redis Secret keys' -Capture
        $requiredKeys = @($RedisPasswordKey)
        if ($ManagedRedis) {
            if ($RedisPasswordKey -ne $RedisUsername) { throw 'INVALID: managed Redis requires RedisPasswordKey to match RedisUsername for native ACL Secret mapping.' }
            $requiredKeys += $RedisAdminPasswordKey
        }
        foreach ($key in $requiredKeys) { if ($keys -notmatch "(?m)^$([regex]::Escape($key))$") { throw "MISSING: key '$key' in Secret '$RedisSecretName'." } }
    }
}
function Save-State {
    [IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $stateDir = Join-Path $backupDir $stamp
    [IO.Directory]::CreateDirectory($stateDir) | Out-Null
    $namespaceExists = Invoke-Tool kubectl @('get','namespace',$namespace,'--ignore-not-found','-o','name') 'Check target namespace' -Capture
    if (-not $namespaceExists) {
        'Namespace did not exist before deployment.' | Set-Content -LiteralPath (Join-Path $stateDir 'namespace-absent.txt')
        Write-Log PASS "CREATED: first-deploy marker at $stateDir"; $summary.Created++
        return
    }
    $releases = Invoke-Tool helm @('list','-n',$namespace,'--output','json') 'List current releases' -Capture
    foreach ($release in @($target,$redisRelease)) {
        if ($releases -match ('"name"\s*:\s*"' + [regex]::Escape($release) + '"')) {
            Invoke-Tool helm @('get','values',$release,'-n',$namespace,'--all','-o','yaml') "Capture values for $release" -Capture | Set-Content -LiteralPath (Join-Path $stateDir "$release-values.yaml")
            Invoke-Tool helm @('get','manifest',$release,'-n',$namespace) "Capture manifest for $release" -Capture | Set-Content -LiteralPath (Join-Path $stateDir "$release-manifest.yaml")
        }
    }
    Invoke-Tool kubectl @('get','all,configmap,pdb,networkpolicy,hpa','-n',$namespace,'-l',"app.kubernetes.io/instance=$target",'-o','yaml') 'Capture current resources' -Capture | Set-Content -LiteralPath (Join-Path $stateDir 'resources.yaml')
    Write-Log PASS "CREATED: backup metadata at $stateDir"; $summary.Created++
}
function Get-ValueArgs {
    $arguments = @()
    if ($ValuesFile) { $arguments += @('--values',$script:ValuesFile) }
    $arguments += @('--set',"redis.credentialsSecret.name=$RedisSecretName")
    if ($ImageRepository) { $arguments += @('--set-string',"image.repository=$ImageRepository") }
    $arguments += @('--set-string',"redis.username=$RedisUsername",'--set-string',"redis.credentialsSecret.passwordKey=$RedisPasswordKey",'--set-string',"redis.instancePrefix=$RedisInstancePrefix")
    if ($ManagedRedis) { $arguments += @('--set','redis.mode=managed','--set',"redis.managedReleaseName=$redisRelease",'--set-string',"redis.managedAdminPasswordKey=$RedisAdminPasswordKey") }
    return $arguments
}
function Get-RedisPrimaryPod {
    $podList = Invoke-Tool kubectl @('get','pod','-n',$namespace,'-l',"app.kubernetes.io/instance=$redisRelease,app.kubernetes.io/component=node",'-o','jsonpath={.items[*].metadata.name}') 'List managed Redis nodes' -Capture
    foreach ($candidate in $podList.Split(' ',[StringSplitOptions]::RemoveEmptyEntries)) {
        $role = Invoke-Tool kubectl @('exec','-n',$namespace,$candidate,'-c','redis','--','sh','-c','REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw ROLE | head -1') "Read Redis role for $candidate" -Capture
        if ($role.Trim() -eq 'master') { return $candidate }
    }
    throw 'UNAVAILABLE: no managed Redis primary was found.'
}
function Backup-Redis {
    [IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $pod = Get-RedisPrimaryPod
    Invoke-Tool kubectl @('exec','-n',$namespace,$pod,'-c','redis','--','sh','-c','REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli BGSAVE; for i in $(seq 1 60); do REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO persistence | grep -q "rdb_bgsave_in_progress:0" && exit 0; sleep 1; done; exit 1') 'Create and await Redis background save'
    $fileName = "redis-$stamp.rdb"
    $destination = Join-Path $backupDir $fileName
    Push-Location -LiteralPath $backupDir
    try { Invoke-Tool kubectl @('cp',"${namespace}/${pod}:/data/dump.rdb","./$fileName",'-c','redis') 'Copy Redis RDB backup' }
    finally { Pop-Location }
    if ((Get-Item -LiteralPath $destination).Length -le 0) { throw 'Redis backup validation failed.' }
    Write-Log PASS "CREATED: validated Redis backup $destination"; $summary.Created++
}

$exitCode = 0
try {
    Phase 'Exclusive lock'
    try { $lockStream = [IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None') } catch { throw "CONCURRENT: another lifecycle run holds $lockPath" }
    Phase 'Prerequisite and target validation'
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'UNSUPPORTED: PowerShell 7 or later is required.' }
    Assert-Target
    if ($Action -eq 'Validate') { $summary.Unchanged++; Write-Log PASS 'UNCHANGED: validation completed.' }
    elseif ($Action -eq 'Plan') {
        $args = @('upgrade','--install',$target,$chart,'-n',$namespace,'--create-namespace','--dry-run=server') + (Get-ValueArgs)
        Invoke-Tool helm $args 'Server-side gateway dry run'; $summary.Skipped++
    }
    elseif ($Action -eq 'BackupRedis') { Backup-Redis }
    elseif ($Action -eq 'RestoreRedis') {
        if (-not $Force) { throw 'GUARD: RestoreRedis requires -Force.' }
        if (-not $BackupFile -or -not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) { throw 'MISSING: valid -BackupFile is required.' }
        if (-not $ManagedRedis) { throw 'GUARD: RestoreRedis is supported only with -ManagedRedis.' }
        if ($PSCmdlet.ShouldProcess("$ExpectedContext/$namespace",'Drain gateway and restore managed Redis from RDB')) {
            Backup-Redis
            $restorePod = "$target-redis-restore"
            $pvc = "redis-data-$redisRelease-node-0"
            $restoreSource = [IO.Path]::GetFullPath($BackupFile)
            $restoreDirectory = Split-Path -Parent $restoreSource
            $restoreName = Split-Path -Leaf $restoreSource
            $podOverrides = @{ spec = @{ securityContext = @{ runAsUser = 1001; runAsGroup = 1001; fsGroup = 1001; seccompProfile = @{ type = 'RuntimeDefault' } }; containers = @(@{ name = $restorePod; image = 'redis@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232'; command = @('/bin/sh','-c','sleep 600'); securityContext = @{ allowPrivilegeEscalation = $false; capabilities = @{ drop = @('ALL') } }; volumeMounts = @(@{ name = 'data'; mountPath = '/data' }) }); volumes = @(@{ name = 'data'; persistentVolumeClaim = @{ claimName = $pvc } }) } } | ConvertTo-Json -Depth 12 -Compress
            try {
                Invoke-Tool kubectl @('delete','hpa',$target,'-n',$namespace,'--ignore-not-found','--wait=true',"--timeout=${TimeoutSeconds}s") 'Suspend gateway autoscaling'
                Invoke-Tool kubectl @('scale',"deployment/$target",'-n',$namespace,'--replicas=0') 'Drain gateway pods'
                Invoke-Tool kubectl @('scale',"statefulset/$redisRelease-node",'-n',$namespace,'--replicas=0') 'Stop managed Redis nodes'
                Invoke-Tool kubectl @('wait','--for=delete','pod','-n',$namespace,'-l',"app.kubernetes.io/instance=$redisRelease,app.kubernetes.io/component=node", "--timeout=${TimeoutSeconds}s") 'Wait for Redis nodes to stop'
                Invoke-Tool kubectl @('run',$restorePod,'-n',$namespace,'--restart=Never',"--image=redis@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232","--overrides=$podOverrides",'--command','--','/bin/sh','-c','sleep 600') 'Mount primary Redis data volume'
                Invoke-Tool kubectl @('wait','--for=condition=Ready',"pod/$restorePod",'-n',$namespace,"--timeout=${TimeoutSeconds}s") 'Wait for restore pod'
                Push-Location -LiteralPath $restoreDirectory
                try { Invoke-Tool kubectl @('cp',"./$restoreName","${namespace}/${restorePod}:/data/dump.rdb") 'Copy replacement RDB' }
                finally { Pop-Location }
                Invoke-Tool kubectl @('exec','-n',$namespace,$restorePod,'--','sh','-c','rm -rf /data/appendonlydir /data/appendonly.aof; test -s /data/dump.rdb') 'Validate restored data file and remove stale AOF'
                Invoke-Tool kubectl @('delete','pod',$restorePod,'-n',$namespace,'--wait=true',"--timeout=${TimeoutSeconds}s") 'Unmount primary data volume'
                Invoke-Tool kubectl @('scale',"statefulset/$redisRelease-node",'-n',$namespace,'--replicas=1') 'Start restored Redis primary'
                Invoke-Tool kubectl @('rollout','status',"statefulset/$redisRelease-node",'-n',$namespace,"--timeout=${TimeoutSeconds}s") 'Validate restored primary'
            }
            finally {
                & kubectl delete pod $restorePod -n $namespace --ignore-not-found --wait=false *> $null
                Invoke-Tool helm @('upgrade',$redisRelease,'oci://registry-1.docker.io/bitnamicharts/redis','--version','23.1.1','-n',$namespace,'--reuse-values','--wait','--atomic',"--timeout=${TimeoutSeconds}s") 'Restore managed Redis replica topology'
                Invoke-Tool helm @('upgrade',$target,$chart,'-n',$namespace,'--reuse-values','--wait','--atomic',"--timeout=${TimeoutSeconds}s") 'Restore gateway topology'
            }
            $summary.Updated++
        }
    }
    elseif ($Action -eq 'Remove') {
        if (-not $Force) { throw 'GUARD: Remove requires -Force.' }
        Save-State
        if ($PSCmdlet.ShouldProcess("$ExpectedContext/$namespace",'Uninstall gateway and optional managed Redis')) {
            Invoke-Tool helm @('uninstall',$target,'-n',$namespace,'--ignore-not-found','--wait',"--timeout=${TimeoutSeconds}s") 'Uninstall gateway'
            if ($ManagedRedis) { Invoke-Tool helm @('uninstall',$redisRelease,'-n',$namespace,'--ignore-not-found','--wait',"--timeout=${TimeoutSeconds}s") 'Uninstall managed Redis' }
            $summary.Updated++
        }
    }
    elseif ($Action -eq 'Rollback') {
        Save-State
        if ($PSCmdlet.ShouldProcess("$ExpectedContext/$namespace/$target",'Rollback gateway to its previous Helm revision')) {
            Invoke-Tool helm @('rollback',$target,'0','-n',$namespace,'--wait','--atomic',"--timeout=${TimeoutSeconds}s") 'Rollback gateway'; $summary.Updated++
        }
    }
    elseif ($Action -eq 'Deploy') {
        Save-State
        if ($DryRun) { Invoke-Tool helm (@('upgrade','--install',$target,$chart,'-n',$namespace,'--create-namespace','--dry-run=server') + (Get-ValueArgs)) 'Dry-run gateway'; $summary.Skipped++ }
        elseif ($PSCmdlet.ShouldProcess("$ExpectedContext/$namespace",'Install or upgrade realtime releases')) {
            if ($ManagedRedis) {
                Invoke-Tool helm @('upgrade','--install',$redisRelease,'oci://registry-1.docker.io/bitnamicharts/redis','--version','23.1.1','-n',$namespace,'--create-namespace','--values',$redisValues,'--set',"fullnameOverride=$redisRelease",'--set',"auth.existingSecret=$RedisSecretName",'--set-string',"auth.existingSecretPasswordKey=$RedisAdminPasswordKey",'--set',"auth.acl.userSecret=$RedisSecretName",'--set-string',"auth.acl.users[0].username=$RedisUsername",'--set-string',"auth.acl.users[0].keys=~${RedisInstancePrefix}:*",'--set-string',"auth.acl.users[0].channels=&${RedisInstancePrefix}:*",'--wait','--atomic',"--timeout=${TimeoutSeconds}s") 'Install or upgrade managed Redis'
            }
            Invoke-Tool helm (@('upgrade','--install',$target,$chart,'-n',$namespace,'--create-namespace','--wait','--atomic',"--timeout=${TimeoutSeconds}s") + (Get-ValueArgs)) 'Install or upgrade gateway'
            Invoke-Tool kubectl @('rollout','restart',"deployment/$target",'-n',$namespace) 'Restart gateway for credential rotation'
            Invoke-Tool kubectl @('rollout','status',"deployment/$target",'-n',$namespace,"--timeout=${TimeoutSeconds}s") 'Validate gateway rollout'
            $summary.Updated++
        }
    }
}
catch { $summary.Errors++; Write-Log FATAL $_.Exception.Message; $exitCode = 1 }
finally {
    if ($lockStream) { $lockStream.Dispose() }
    Phase 'Log retention and summary'
    $old = @(Get-ChildItem -LiteralPath $logDir -Filter 'Deploy-Realtime-*.log' -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7))
    if ($old.Count) {
        $zip = Join-Path $logDir "Deploy-Realtime-Archive-$stamp.zip"
        Compress-Archive -LiteralPath $old.FullName -DestinationPath $zip
        $archive = [IO.Compression.ZipFile]::OpenRead($zip)
        try { if ($archive.Entries.Count -ne $old.Count) { throw 'Log archive validation failed; originals retained.' } } finally { $archive.Dispose() }
        $old | Remove-Item -Force
    }
    $summary.GetEnumerator() | ForEach-Object { Write-Log INFO "$($_.Key): $($_.Value)" }
    Write-Log $(if($exitCode){'ERROR'}else{'PASS'}) "Status: $(if($exitCode){'FAILURE'}else{'SUCCESS'}). Log: $logPath"
}
exit $exitCode
