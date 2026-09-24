namespace Cormier.Realtime.KubernetesTests;

using System.Text.Json;

public sealed class DeploymentContractTests
{
    private static readonly string Root = FindRepositoryRoot();

    [Fact]
    public void GatewayChartContainsRequiredWorkloadControls()
    {
        var deployment = Read("helm/realtime-gateway/templates/deployment.yaml");
        using var schema = JsonDocument.Parse(Read("helm/realtime-gateway/values.schema.json"));

        Assert.Contains("runAsNonRoot: true", deployment, StringComparison.Ordinal);
        Assert.Contains("readOnlyRootFilesystem: true", deployment, StringComparison.Ordinal);
        Assert.Contains("allowPrivilegeEscalation: false", deployment, StringComparison.Ordinal);
        Assert.Contains("capabilities: { drop: [\"ALL\"] }", deployment, StringComparison.Ordinal);
        Assert.Contains("automountServiceAccountToken:", deployment, StringComparison.Ordinal);
        Assert.Contains("imagePullSecrets:", deployment, StringComparison.Ordinal);
        Assert.Contains(".Values.image.pullSecretName", deployment, StringComparison.Ordinal);
        Assert.Contains("startupProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("readinessProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("livenessProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("topologySpreadConstraints:", deployment, StringComparison.Ordinal);
        Assert.Contains("whenUnsatisfiable: DoNotSchedule", deployment, StringComparison.Ordinal);
        Assert.Contains("deploymentStrategy.maxUnavailable", deployment, StringComparison.Ordinal);
        Assert.Contains("deploymentStrategy.maxSurge", deployment, StringComparison.Ordinal);
        Assert.Contains("resources:", deployment, StringComparison.Ordinal);
        Assert.Contains("containerPort: {{ .Values.service.targetPort }}", deployment, StringComparison.Ordinal);
        Assert.Contains("ASPNETCORE_HTTP_PORTS", deployment, StringComparison.Ordinal);
        var strategy = schema.RootElement.GetProperty("properties").GetProperty("deploymentStrategy");
        var forbidden = strategy.GetProperty("not").GetProperty("properties");
        Assert.Equal(1, schema.RootElement.GetProperty("properties").GetProperty("replicaCount").GetProperty("minimum").GetInt32());
        Assert.Equal(1, schema.RootElement.GetProperty("properties").GetProperty("autoscaling").GetProperty("properties").GetProperty("minReplicas").GetProperty("minimum").GetInt32());
        Assert.Equal(1, schema.RootElement.GetProperty("properties").GetProperty("autoscaling").GetProperty("properties").GetProperty("maxReplicas").GetProperty("minimum").GetInt32());
        Assert.Contains("autoscaling.maxReplicas must be greater than or equal to autoscaling.minReplicas", Read("helm/realtime-gateway/templates/hpa.yaml"), StringComparison.Ordinal);
        Assert.Equal(1, strategy.GetProperty("properties").GetProperty("maxUnavailable").GetProperty("maximum").GetInt32());
        Assert.Equal(0, strategy.GetProperty("properties").GetProperty("maxSurge").GetProperty("minimum").GetInt32());
        Assert.Equal(0, forbidden.GetProperty("maxUnavailable").GetProperty("const").GetInt32());
        Assert.Equal(0, forbidden.GetProperty("maxSurge").GetProperty("const").GetInt32());

        var topologyRules = schema.RootElement.GetProperty("allOf").EnumerateArray()
            .Where(rule => rule.TryGetProperty("if", out var condition)
                && condition.GetProperty("properties").TryGetProperty("topology", out _))
            .ToDictionary(
                rule => rule.GetProperty("if").GetProperty("properties").GetProperty("topology").GetProperty("const").GetString()!,
                rule => rule.GetProperty("then").GetProperty("properties"));
        Assert.Equal(3, topologyRules["ha"].GetProperty("replicaCount").GetProperty("minimum").GetInt32());
        Assert.Equal(0, topologyRules["ha"].GetProperty("deploymentStrategy").GetProperty("properties").GetProperty("maxUnavailable").GetProperty("const").GetInt32());
        Assert.Equal(1, topologyRules["non-ha"].GetProperty("replicaCount").GetProperty("const").GetInt32());
        var nonHaAutoscaling = topologyRules["non-ha"].GetProperty("autoscaling").GetProperty("properties");
        Assert.False(nonHaAutoscaling.GetProperty("enabled").GetProperty("const").GetBoolean());
        Assert.Equal(1, nonHaAutoscaling.GetProperty("minReplicas").GetProperty("const").GetInt32());
        Assert.Equal(1, nonHaAutoscaling.GetProperty("maxReplicas").GetProperty("const").GetInt32());
        Assert.Contains("Gateway__Topology: {{ .Values.topology", Read("helm/realtime-gateway/templates/configmap.yaml"), StringComparison.Ordinal);
    }

    [Fact]
    public void GatewayChartReferencesCredentialsWithoutCreatingSecrets()
    {
        var files = Directory.GetFiles(
            Path.Join(Root, "helm", "realtime-gateway", "templates"),
            "*",
            SearchOption.AllDirectories);
        var content = string.Join('\n', files.Select(File.ReadAllText));

        Assert.DoesNotContain("kind: Secret", content, StringComparison.Ordinal);
        Assert.Contains("secretKeyRef:", content, StringComparison.Ordinal);
        Assert.Contains("Redis__Password", content, StringComparison.Ordinal);
        Assert.Contains("Redis__User", content, StringComparison.Ordinal);
        Assert.Contains("Redis__SentinelServiceName", content, StringComparison.Ordinal);
        Assert.Contains("Redis__SentinelPassword", content, StringComparison.Ordinal);
        Assert.Contains("-client", content, StringComparison.Ordinal);
        Assert.DoesNotContain("ACL SETUSER", content, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedRedisIsPinnedAndReliableByDefault()
    {
        var values = Read("cluster/redis/managed-values.yaml");
        var chart = Read("helm/realtime-gateway/Chart.yaml");

        Assert.Contains("redis@23.1.1", chart, StringComparison.Ordinal);
        Assert.Contains("architecture: replication", values, StringComparison.Ordinal);
        Assert.Contains("sentinel:", values, StringComparison.Ordinal);
        Assert.Contains("acl:", values, StringComparison.Ordinal);
        Assert.Contains("userSecret:", values, StringComparison.Ordinal);
        Assert.Contains("sentinel: true", values, StringComparison.Ordinal);
        Assert.Contains("persistence: { enabled: true", values, StringComparison.Ordinal);
        Assert.Contains("appendonly yes", values, StringComparison.Ordinal);
        Assert.Contains("metrics:", values, StringComparison.Ordinal);
        Assert.Contains("networkPolicy:", values, StringComparison.Ordinal);
        Assert.DoesNotContain("password:", values, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LifecycleAutomationHasSafetyAndRecoveryControls()
    {
        var script = Read("scripts/Deploy-Realtime.ps1");

        Assert.Contains("ExpectedContext", script, StringComparison.Ordinal);
        Assert.Contains("ShouldProcess", script, StringComparison.Ordinal);
        Assert.Contains("CONCURRENT:", script, StringComparison.Ordinal);
        Assert.Contains("Save-State", script, StringComparison.Ordinal);
        Assert.Contains("--atomic", script, StringComparison.Ordinal);
        Assert.Contains("BackupRedis", script, StringComparison.Ordinal);
        Assert.Contains("RestoreRedis", script, StringComparison.Ordinal);
        Assert.Contains("'delete','hpa'", script, StringComparison.Ordinal);
        Assert.Contains("'rollout','restart'", script, StringComparison.Ordinal);
        Assert.Contains("Rollback gateway to its previous Helm revision", script, StringComparison.Ordinal);
        Assert.Contains("RedisPasswordKey", script, StringComparison.Ordinal);
        Assert.Contains("AddDays(-7)", script, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", script, StringComparison.Ordinal);
        Assert.Contains(".backups/", Read(".gitignore"), StringComparison.Ordinal);
    }

    [Fact]
    public void EdgeConfigurationKeepsGatewayPrivateAndTerminatesWssAtTraefik()
    {
        var service = Read("helm/realtime-gateway/templates/service.yaml");
        var route = Read("helm/realtime-gateway/templates/ingressroute.yaml");
        var gatewayValues = Read("cluster/edge/development/gateway-values.yaml");
        var traefikValues = Read("cluster/edge/development/traefik-values.yaml");
        var metalLb = Read("cluster/edge/development/metallb.yaml");
        var certificate = Read("cluster/edge/development/certificate.yaml");

        Assert.Contains("type: ClusterIP", service, StringComparison.Ordinal);
        Assert.Contains("Host(`{{ .Values.ingressRoute.host }}`) && Path(`{{ .Values.ingressRoute.path }}`)", route, StringComparison.Ordinal);
        Assert.Contains(".Values.ingressRoute.entryPoint", route, StringComparison.Ordinal);
        Assert.Contains("flushInterval: \"-1ms\"", route, StringComparison.Ordinal);
        Assert.Contains("realtime.cormier.local", gatewayValues, StringComparison.Ordinal);
        Assert.Contains("https://realtime.cormier.local", gatewayValues, StringComparison.Ordinal);
        Assert.DoesNotContain("https://cormier.local", gatewayValues, StringComparison.Ordinal);
        Assert.Contains("externalTrafficPolicy: Local", traefikValues, StringComparison.Ordinal);
        Assert.Contains("redirections:", traefikValues, StringComparison.Ordinal);
        Assert.DoesNotContain("redirectTo:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("replicas: 3", traefikValues, StringComparison.Ordinal);
        Assert.Contains("maxUnavailable: 1", traefikValues, StringComparison.Ordinal);
        Assert.Contains("maxSurge: 0", traefikValues, StringComparison.Ordinal);
        Assert.Contains("requiredDuringSchedulingIgnoredDuringExecution", traefikValues, StringComparison.Ordinal);
        Assert.Contains("defaultmode: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("general:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("format: json", traefikValues, StringComparison.Ordinal);
        Assert.Contains("RequestPath: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("RequestPort: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("external-dns.alpha.kubernetes.io/hostname: realtime.cormier.local", traefikValues, StringComparison.Ordinal);
        Assert.Contains("prometheus:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("idletimeout=120s", traefikValues, StringComparison.Ordinal);
        Assert.Contains("topologySpreadConstraints:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("development-traefik", metalLb, StringComparison.Ordinal);
        Assert.Contains("kind: L2Advertisement", metalLb, StringComparison.Ordinal);
        Assert.Contains("192.0.2.240-192.0.2.250", metalLb, StringComparison.Ordinal);
        Assert.Contains("realtime.cormier.local", certificate, StringComparison.Ordinal);
    }

    [Fact]
    public void EdgeValidationAutomationProtectsTargetAndSecrets()
    {
        var script = Read("scripts/Test-RealtimeEdge.ps1");

        Assert.Contains("ExpectedContext", script, StringComparison.Ordinal);
        Assert.Contains("TARGET MISMATCH", script, StringComparison.Ordinal);
        Assert.Contains("externalTrafficPolicy", script, StringComparison.Ordinal);
        Assert.Contains("type ClusterIP", script, StringComparison.Ordinal);
        Assert.Contains("[Net.Dns]::GetHostAddresses", script, StringComparison.Ordinal);
        Assert.Contains("Certificate is Ready", script, StringComparison.Ordinal);
        Assert.Contains("CertificateAuthorityPath", script, StringComparison.Ordinal);
        Assert.Contains("CertificateAuthorityCertificateName", script, StringComparison.Ordinal);
        Assert.Contains("ExternalPort", script, StringComparison.Ordinal);
        Assert.Contains("ExternalAddress", script, StringComparison.Ordinal);
        Assert.Contains("ConnectCallback", script, StringComparison.Ordinal);
        Assert.Contains("ConnectionReadyFile", script, StringComparison.Ordinal);
        Assert.Contains("ConnectionStopFile", script, StringComparison.Ordinal);
        Assert.Contains("TicketRefreshCommand", script, StringComparison.Ordinal);
        Assert.Contains("ReconnectOnTransportFailure", script, StringComparison.Ordinal);
        Assert.Contains("--context", script, StringComparison.Ordinal);
        Assert.Contains("Ready CertificateRequest", script, StringComparison.Ordinal);
        Assert.Contains("externally served TLS leaf", script, StringComparison.Ordinal);
        Assert.Contains("Traefik desired and running revisions", script, StringComparison.Ordinal);
        Assert.Contains("x-cormier-origin-validated", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("GatewayPodSelector", script, StringComparison.Ordinal);
        Assert.Contains("Test-IpAddressInPool", script, StringComparison.Ordinal);
        Assert.Contains("curl 7.84.0", script, StringComparison.Ordinal);
        Assert.Contains("Sha256Async", script, StringComparison.Ordinal);
        Assert.Contains("$heartbeatDeadline", script, StringComparison.Ordinal);
        Assert.Contains("'--context', $ExpectedContext, 'port-forward'", script, StringComparison.Ordinal);
        Assert.Contains("observedClientAddresses", script, StringComparison.Ordinal);
        Assert.Contains("--since-time=", script, StringComparison.Ordinal);
        Assert.Contains("MetalLbAdvertisementMode", script, StringComparison.Ordinal);
        Assert.Contains("Get-CertificateRequestMaterial", script, StringComparison.Ordinal);
        Assert.Contains("GatewayMetricsPort", script, StringComparison.Ordinal);
        Assert.Contains("CustomTrustStore.AddRange", script, StringComparison.Ordinal);
        Assert.Contains("ExtraStore.Add", script, StringComparison.Ordinal);
        Assert.Contains("Test-CertificateDnsName", script, StringComparison.Ordinal);
        Assert.Contains("CertificateAuthorityCertificateNamespace", script, StringComparison.Ordinal);
        Assert.DoesNotContain("Get-Json @('get', 'secret'", script, StringComparison.Ordinal);
        Assert.Contains("PowerShell 7.4", script, StringComparison.Ordinal);
        Assert.Contains("Certificate does not cover configured host", script, StringComparison.Ordinal);
        Assert.Contains("IngressRoute and Certificate reference different TLS Secrets", script, StringComparison.Ordinal);
        Assert.Contains("Invalid host is rejected", script, StringComparison.Ordinal);
        Assert.Contains("Invalid Origin is rejected", script, StringComparison.Ordinal);
        Assert.Contains("Approved Origin did not reach the session-authentication path", script, StringComparison.Ordinal);
        Assert.Contains("cormier_realtime_authentication_total", script, StringComparison.Ordinal);
        Assert.Contains("MetalLB speakers are not ready", script, StringComparison.Ordinal);
        Assert.Contains("TraefikPodSelector", script, StringComparison.Ordinal);
        Assert.Contains("ExpectedClientIp", script, StringComparison.Ordinal);
        Assert.Contains("HeartbeatSeconds", script, StringComparison.Ordinal);
        Assert.Contains("respondingtimeouts", script, StringComparison.Ordinal);
        Assert.Contains("accesslog.fields.names", script, StringComparison.Ordinal);
        Assert.Contains("Test-LabelSelector", script, StringComparison.Ordinal);
        Assert.Contains("active MetalLB L2 announcer", script, StringComparison.Ordinal);
        Assert.Contains("active MetalLB BGP announcer", script, StringComparison.Ordinal);
        Assert.Contains("eligibleAdvertisementNodes", script, StringComparison.Ordinal);
        Assert.Contains("Get-MaxUnavailableCount", script, StringComparison.Ordinal);
        Assert.Contains("namespaceSelectors", script, StringComparison.Ordinal);
        Assert.Contains("ipAddressPoolSelectors", script, StringComparison.Ordinal);
        Assert.Contains("Fewer than two active MetalLB BGP announcers", script, StringComparison.Ordinal);
        Assert.Contains("PodDisruptionBudget", script, StringComparison.Ordinal);
        Assert.Contains("rollout scheduling deadlock", script, StringComparison.Ordinal);
        Assert.Contains("required two-replica floor", script, StringComparison.Ordinal);
        Assert.Contains("CreateInvoker($connectionAddress", script, StringComparison.Ordinal);
        Assert.Contains("remainingMilliseconds", script, StringComparison.Ordinal);
        Assert.Contains("$effectiveOrigin", script, StringComparison.Ordinal);
        Assert.Contains("REALTIME_EDGE_TICKET", script, StringComparison.Ordinal);
        Assert.Contains("Invalid route is rejected", script, StringComparison.Ordinal);
        Assert.DoesNotContain("Write-Host $ticket", script, StringComparison.Ordinal);
    }

    [Fact]
    public void EdgeFailureAutomationIsBoundedAndRestoresState()
    {
        var script = Read("scripts/Invoke-RealtimeEdgeFailureTest.ps1");

        Assert.Contains("SupportsShouldProcess", script, StringComparison.Ordinal);
        Assert.Contains("TARGET MISMATCH", script, StringComparison.Ordinal);
        Assert.Contains("SAFETY STOP", script, StringComparison.Ordinal);
        Assert.Contains("cormier.io/failure-testing", script, StringComparison.Ordinal);
        Assert.Contains("cormier.io/environment", script, StringComparison.Ordinal);
        Assert.Contains("finally", script, StringComparison.Ordinal);
        Assert.Contains("Restore gateway replicas", script, StringComparison.Ordinal);
        Assert.Contains("Restore TLS Secret reference", script, StringComparison.Ordinal);
        Assert.Contains("CertificateRenewal", script, StringComparison.Ordinal);
        Assert.Contains("parallel replacement Certificate", script, StringComparison.Ordinal);
        Assert.DoesNotContain("delete', 'secret', $tlsSecretName", script, StringComparison.Ordinal);
        Assert.Contains("servicel2status", script, StringComparison.Ordinal);
        Assert.Contains("exit code 60", script, StringComparison.Ordinal);
        Assert.Contains("Wait-DeploymentFullyRecovered", script, StringComparison.Ordinal);
        Assert.Contains("MetalLbAdvertisementMode", script, StringComparison.Ordinal);
        Assert.Contains("Start-ContinuityProbe", script, StringComparison.Ordinal);
        Assert.Contains("Complete-ContinuityProbe", script, StringComparison.Ordinal);
        Assert.Contains("continuityStopPath", script, StringComparison.Ordinal);
        Assert.Contains("replacement-certificate.log", script, StringComparison.Ordinal);
        Assert.Contains("does not host a pod from the selected gateway or Traefik workload", script, StringComparison.Ordinal);
        Assert.Contains("Baseline and recovery checks intentionally do not consume it", script, StringComparison.Ordinal);
        Assert.Contains("CertificateAuthorityCertificateName", script, StringComparison.Ordinal);
        Assert.Contains("ExpectedClientIp", script, StringComparison.Ordinal);
        Assert.Contains("GatewayMetricsPort", script, StringComparison.Ordinal);
        Assert.Contains("Suspend gateway HPA", script, StringComparison.Ordinal);
        Assert.Contains("Restore gateway HPA", script, StringComparison.Ordinal);
        Assert.Contains("Assert-ApprovedMetadata", script, StringComparison.Ordinal);
        Assert.Contains("Acquire-FailureLock", script, StringComparison.Ordinal);
        Assert.Contains("Release-FailureLock", script, StringComparison.Ordinal);
        Assert.Contains("TicketRefreshCommand", script, StringComparison.Ordinal);
        Assert.Contains("ContinuitySafetySeconds", script, StringComparison.Ordinal);
        Assert.Contains("cormier.io/edge-failure-lock=canonical", script, StringComparison.Ordinal);
        Assert.Contains("cormier.io/environment-class", script, StringComparison.Ordinal);
        Assert.Contains("Get-GatewayActiveConnectionsByPod", script, StringComparison.Ordinal);
        Assert.Contains("Delete the gateway pod serving the continuity socket", script, StringComparison.Ordinal);
        Assert.Contains("Inventory pods affected by node drain", script, StringComparison.Ordinal);
        Assert.Contains("node-drain namespace", script, StringComparison.Ordinal);
        Assert.Contains("ReconnectOnTransportFailure", script, StringComparison.Ordinal);
        Assert.Contains("Get-CertificateRequestCaPem", script, StringComparison.Ordinal);
        Assert.Contains("GatewayPodSelector", script, StringComparison.Ordinal);
        Assert.Contains("realtime-edge-failure", script, StringComparison.Ordinal);
        Assert.Contains("Release owned edge failure-test lock", script, StringComparison.Ordinal);
        Assert.Contains("resourceVersion", script, StringComparison.Ordinal);
        Assert.DoesNotContain("get', 'secret'", script, StringComparison.Ordinal);
        Assert.Contains("50 * $TimeoutSeconds", script, StringComparison.Ordinal);
        Assert.Contains("servicebgpstatus", script, StringComparison.Ordinal);
        Assert.Contains("Prove every replica redistributed before ending the maintenance window", script, StringComparison.Ordinal);
        Assert.Contains("redistributionError", script, StringComparison.Ordinal);
        var scriptReadme = Read("scripts/README.md");
        Assert.Contains("CertificateAuthorityCertificateName", scriptReadme, StringComparison.Ordinal);
        Assert.Contains("TicketRefreshCommand $ticketRefreshCommand", scriptReadme, StringComparison.Ordinal);
        Assert.Contains("Reclaim expired edge failure-test lock", script, StringComparison.Ordinal);
        Assert.Contains("Verify edge failure-test lock ownership", script, StringComparison.Ordinal);
        Assert.Contains("--context", script, StringComparison.Ordinal);
        Assert.Contains("deletionTimestamp", script, StringComparison.Ordinal);
        Assert.Contains("DeletedPodUid", script, StringComparison.Ordinal);
        Assert.Contains("metadata.annotations", script, StringComparison.Ordinal);
        Assert.Contains("status.phase -eq 'Running'", script, StringComparison.Ordinal);
        Assert.DoesNotContain("2>&1", script, StringComparison.Ordinal);
        Assert.Contains("Restore route match", script, StringComparison.Ordinal);
        Assert.Contains("Uncordon target node", script, StringComparison.Ordinal);
        Assert.Contains("Invoke-EdgeValidation", script, StringComparison.Ordinal);
        Assert.Contains("during-failure.log", script, StringComparison.Ordinal);
        Assert.DoesNotContain("tls.key", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("redis-password", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("passwordKey", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(".evidence/", Read(".gitignore"), StringComparison.Ordinal);
    }

    [Fact]
    public void ObservabilityIsProvisionedWithSafeVariablesAndActionableRouting()
    {
        var dashboardText = Read("helm/realtime-gateway/dashboards/realtime-gateway.json");
        using var dashboard = JsonDocument.Parse(dashboardText);
        var variables = dashboard.RootElement.GetProperty("templating").GetProperty("list")
            .EnumerateArray().Select(item => item.GetProperty("name").GetString()!).ToArray();
        Assert.Equal(["environment", "cluster", "namespace", "instance", "pod"], variables);
        Assert.DoesNotContain("tenant", dashboardText, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user_id", dashboardText, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Message throughput", dashboardText, StringComparison.Ordinal);
        Assert.Contains("Redis operations", dashboardText, StringComparison.Ordinal);
        Assert.Contains("Traefik", dashboardText, StringComparison.Ordinal);
        Assert.Contains("MetalLB", dashboardText, StringComparison.Ordinal);
        Assert.Contains("Certificate expiry", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__CERTIFICATE_NAME__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__REDIS_NAMESPACE__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__REDIS_INSTANCE__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__METALLB_NAMESPACE__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__METALLB_ADDRESS__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__LOGS_URL__", dashboardText, StringComparison.Ordinal);
        Assert.Contains("__TRACES_URL__", dashboardText, StringComparison.Ordinal);
        Assert.Equal("__DASHBOARD_UID__", dashboard.RootElement.GetProperty("uid").GetString());
        foreach (var expression in dashboard.RootElement.GetProperty("panels").EnumerateArray()
                     .SelectMany(panel => panel.GetProperty("targets").EnumerateArray())
                     .Select(target => target.GetProperty("expr").GetString()!)
                     .Where(expression => expression.Contains("cormier_realtime_", StringComparison.Ordinal)))
        {
            Assert.Contains("service=\"__SERVICE_NAME__\"", expression, StringComparison.Ordinal);
            Assert.Contains("instance=~\"$instance\"", expression, StringComparison.Ordinal);
        }
        Assert.Contains(
            dashboard.RootElement.GetProperty("templating").GetProperty("list").EnumerateArray(),
            variable => variable.GetProperty("query").GetString()!.Contains("pod=~\"^__SERVICE_NAME__-[a-z0-9]+-[a-z0-9]+$\"", StringComparison.Ordinal));
        Assert.Contains(
            dashboard.RootElement.GetProperty("panels").EnumerateArray()
                .SelectMany(panel => panel.GetProperty("targets").EnumerateArray()),
            target => target.GetProperty("expr").GetString()!.Contains("deployment=\"__SERVICE_NAME__\"", StringComparison.Ordinal));
        var dashboardExpressions = dashboard.RootElement.GetProperty("panels").EnumerateArray()
            .SelectMany(panel => panel.GetProperty("targets").EnumerateArray())
            .Select(target => target.GetProperty("expr").GetString()!).ToArray();
        foreach (var expression in dashboardExpressions.Where(expression =>
                     !expression.Contains("cormier_realtime_", StringComparison.Ordinal) &&
                     !expression.StartsWith("sum(up", StringComparison.Ordinal)))
        {
            Assert.DoesNotContain("environment=", expression, StringComparison.Ordinal);
            Assert.DoesNotContain("cluster=", expression, StringComparison.Ordinal);
        }
        Assert.Contains(dashboardExpressions,
            expression => expression.Contains("container_cpu_cfs_throttled_seconds_total", StringComparison.Ordinal)
                && expression.Contains("container!=\"\"", StringComparison.Ordinal));
        Assert.Contains(dashboardExpressions,
            expression => expression.Contains("redis_memory_used_bytes", StringComparison.Ordinal)
                && expression.Contains("namespace=\"__REDIS_NAMESPACE__\"", StringComparison.Ordinal)
                && expression.Contains("instance=\"__REDIS_INSTANCE__\"", StringComparison.Ordinal));

        var rules = Read("helm/realtime-gateway/templates/prometheusrule.yaml");
        foreach (var alert in new[] { "RealtimeGatewayUnavailable", "RealtimeGatewayReadinessFailure", "RealtimeGatewayCrashLooping", "RealtimeGatewayAbnormalDisconnects", "RealtimeGatewayReconnectStorm", "RealtimeGatewayAuthenticationFailures", "RealtimeGatewayAuthorizationFailures", "RealtimeGatewayQueueDrops", "RealtimeGatewayQueueSaturation", "RealtimeGatewaySlowConsumers", "RealtimeGatewayHandlerLatency", "RealtimeGatewayRedisErrors", "RealtimeGatewayRedisDisconnected", "RealtimeGatewayRedisLatency", "RealtimeGatewayCertificateExpiring", "RealtimeGatewayCertificateNotReady", "RealtimeGatewayEdgeErrors", "RealtimeGatewayVipAdvertisementLost", "RealtimeGatewayRolloutFailed" })
        {
            Assert.Contains($"alert: {alert}", rules, StringComparison.Ordinal);
        }
        Assert.Contains("runbook_url:", rules, StringComparison.Ordinal);
        Assert.Contains("routingLabels", rules, StringComparison.Ordinal);
        Assert.Contains("or absent(up", rules, StringComparison.Ordinal);
        Assert.Contains("deployment={{ include \"realtime-gateway.fullname\"", rules, StringComparison.Ordinal);
        Assert.Contains("metalLbAdvertisementMode", rules, StringComparison.Ordinal);
        Assert.Contains("metallb_layer2_responses_sent", rules, StringComparison.Ordinal);
        Assert.Contains("ip={{ .Values.observability.platformMetrics.metalLbAddress", rules, StringComparison.Ordinal);
        Assert.Contains("sum(increase(cormier_realtime_connections_opened_total", rules, StringComparison.Ordinal);
        Assert.Contains("sum(increase(cormier_realtime_redis_operations_total", rules, StringComparison.Ordinal);
        Assert.Contains("[10m])) > 0", rules, StringComparison.Ordinal);
        Assert.Contains("printf \"^%s-[a-z0-9]+-[a-z0-9]+$\"", rules, StringComparison.Ordinal);
        Assert.Contains("increase(cormier_realtime_queue_dropped_total", rules, StringComparison.Ordinal);
        Assert.Contains("increase(cormier_realtime_slow_consumer_disconnects_total", rules, StringComparison.Ordinal);
        Assert.Contains("name={{ $certificateName", rules, StringComparison.Ordinal);
        Assert.Contains("cormier_realtime_connections_closed_total", rules, StringComparison.Ordinal);
        Assert.Contains("reason=~\"abrupt_disconnect|socket_closed\"", rules, StringComparison.Ordinal);
        Assert.Contains("traefikNamespace", rules, StringComparison.Ordinal);
        Assert.Contains("service=~{{ $traefikServicePattern", rules, StringComparison.Ordinal);
        Assert.Contains("printf \"^%s-%s-%v@kubernetescrd$\"", rules, StringComparison.Ordinal);
        Assert.Contains("kube_deployment_status_replicas_available", rules, StringComparison.Ordinal);
        Assert.Contains("kube_deployment_spec_replicas", rules, StringComparison.Ordinal);
        Assert.Contains("absent(certmanager_certificate_ready_status", rules, StringComparison.Ordinal);
        Assert.Contains("set .Values.observability.prometheusRule.routingLabels \"namespace\"", rules, StringComparison.Ordinal);
        foreach (var expression in rules.Split('\n').Where(line => line.Contains("expr:", StringComparison.Ordinal) && line.Contains("cormier_realtime_", StringComparison.Ordinal)))
        {
            Assert.Contains("namespace=", expression, StringComparison.Ordinal);
            Assert.Contains("service=", expression, StringComparison.Ordinal);
        }
        Assert.Contains("urlSecret:", Read("helm/realtime-gateway/templates/alertmanagerconfig.yaml"), StringComparison.Ordinal);
        Assert.Contains("default (include \"realtime-gateway.fullname\"", Read("helm/realtime-gateway/templates/alertmanagerconfig.yaml"), StringComparison.Ordinal);
        Assert.Contains("name: namespace", Read("helm/realtime-gateway/templates/alertmanagerconfig.yaml"), StringComparison.Ordinal);
        Assert.Contains("kind: ServiceMonitor", Read("helm/realtime-gateway/templates/servicemonitor.yaml"), StringComparison.Ordinal);
        Assert.Contains("Capabilities.APIVersions.Has", Read("helm/realtime-gateway/templates/servicemonitor.yaml"), StringComparison.Ordinal);
        Assert.Contains("targetLabel: cluster", Read("helm/realtime-gateway/templates/servicemonitor.yaml"), StringComparison.Ordinal);
        Assert.Contains("monitoringNamespaceSelector", Read("helm/realtime-gateway/templates/networkpolicy.yaml"), StringComparison.Ordinal);
        Assert.Contains("port: {{ .Values.service.targetPort }}", Read("helm/realtime-gateway/templates/networkpolicy.yaml"), StringComparison.Ordinal);
        var hpa = Read("helm/realtime-gateway/templates/hpa.yaml");
        Assert.Contains("cormier_realtime_active_connections", hpa, StringComparison.Ordinal);
        Assert.Contains("cormier_realtime_queue_depth", hpa, StringComparison.Ordinal);

        var handler = Read("src/Cormier.Realtime.AspNetCore/RealtimeWebSocketHandler.cs");
        Assert.Contains("closeReason = await heartbeat ?? \"cancelled\"", handler, StringComparison.Ordinal);
        Assert.Contains("heartbeatCloseReason.Task.IsCompletedSuccessfully", handler, StringComparison.Ordinal);
        Assert.Contains("closeReason.TrySetResult(\"slow_consumer\")", handler, StringComparison.Ordinal);
        Assert.Contains("return \"heartbeat_timeout\"", handler, StringComparison.Ordinal);
        Assert.Contains("return \"slow_consumer\"", handler, StringComparison.Ordinal);

        var connection = Read("src/Cormier.Realtime.AspNetCore/RealtimeConnection.cs");
        Assert.Contains("RemoveQueuedMessage()", connection, StringComparison.Ordinal);
        Assert.Contains("lock (_queueAccountingLock)", connection, StringComparison.Ordinal);
        Assert.Contains("Volatile.Write(ref _disposing, 1)", connection, StringComparison.Ordinal);
        Assert.Contains("Interlocked.CompareExchange(ref _queuedMessages, queued - 1, queued)", connection, StringComparison.Ordinal);

        var dispatcher = Read("src/Cormier.Realtime.AspNetCore/RealtimeDispatcher.cs");
        Assert.Contains("catch (OperationCanceledException)", dispatcher, StringComparison.Ordinal);
        Assert.Contains("outcome = \"cancelled\"", dispatcher, StringComparison.Ordinal);
        Assert.Contains("messageOutcome = \"rejected\"", dispatcher, StringComparison.Ordinal);
        Assert.Contains("messageOutcome = \"error\"", dispatcher, StringComparison.Ordinal);
        Assert.Contains("RecordMessage(\"inbound\", messageOutcome)", dispatcher, StringComparison.Ordinal);
        Assert.Contains("catch\n        {\n            outcome = \"failure\"", dispatcher.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);

        var subscriber = Read("src/Cormier.Realtime.AspNetCore/RedisSubscriberService.cs");
        Assert.Contains("ConnectionFailed +=", subscriber, StringComparison.Ordinal);
        Assert.Contains("ConnectionRestored +=", subscriber, StringComparison.Ordinal);
        Assert.Contains("eventArgs.ConnectionType == ConnectionType.Subscription", subscriber, StringComparison.Ordinal);
        Assert.Contains("MarkSubscription(false)", subscriber, StringComparison.Ordinal);
        Assert.Contains("RecordRedisDuration(\"subscribe\", Stopwatch.GetElapsedTime(subscribeStarted), false)", subscriber, StringComparison.Ordinal);

        var dashboardTemplate = Read("helm/realtime-gateway/templates/grafana-dashboard.yaml");
        Assert.Contains("sha256sum $dashboardIdentity", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains("replace \"__DASHBOARD_UID__\"", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains(".Values.observability.platformMetrics.redisNamespace", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains(".Values.observability.platformMetrics.redisInstance", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains("replace \"__REDIS_NAMESPACE__\"", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains("replace \"__REDIS_INSTANCE__\"", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains("replace \"__METALLB_NAMESPACE__\"", dashboardTemplate, StringComparison.Ordinal);
        Assert.Contains("replace \"__METALLB_ADDRESS__\"", dashboardTemplate, StringComparison.Ordinal);

        var authentication = Read("src/Cormier.Realtime.AspNetCore/RealtimeAuthentication.cs");
        Assert.Contains("ObserveRedisAsync", authentication, StringComparison.Ordinal);
        Assert.Contains("RecordAuthentication(true, \"origin\")", authentication, StringComparison.Ordinal);
        Assert.Contains("\"session_read\"", authentication, StringComparison.Ordinal);
        Assert.Contains("\"ticket_consume\"", authentication, StringComparison.Ordinal);
        Assert.Contains("\"ticket_issue\"", authentication, StringComparison.Ordinal);
    }

    [Fact]
    public void PromotionReusesAnImmutableDigestAndSupportsRollback()
    {
        var publish = Read(".github/workflows/publish.yml");
        var promote = Read(".github/workflows/promote.yml");
        Assert.Contains("workflow_run:", publish, StringComparison.Ordinal);
        Assert.Contains("download-artifact", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("dotnet publish", publish, StringComparison.Ordinal);
        Assert.Contains("archiveSha256", publish, StringComparison.Ordinal);
        Assert.Contains("vars.CONTAINER_REGISTRY", publish, StringComparison.Ordinal);
        Assert.Contains("vars.REGISTRY_CREDENTIAL_PROVIDER", publish, StringComparison.Ordinal);
        Assert.Contains("vars.GHCR_PUBLISH_REGISTRY", publish, StringComparison.Ordinal);
        Assert.Contains("test \"$CONTAINER_REGISTRY\" = \"$CREDENTIAL_REGISTRY\"", publish, StringComparison.Ordinal);
        Assert.Contains("github.token", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.HARBOR_PUBLISH_USERNAME", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.HARBOR_PUBLISH_TOKEN", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets.HARBOR_USERNAME", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets.HARBOR_TOKEN", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.DOCKERHUB_USERNAME", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.DOCKERHUB_TOKEN", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.REGISTRY_USERNAME", publish, StringComparison.Ordinal);
        Assert.Contains("secrets.REGISTRY_PASSWORD", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets[", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("username: ${{ github.actor }}", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("'ghcr.io'", publish, StringComparison.Ordinal);
        Assert.Contains("rollbackPublishRunId", promote, StringComparison.Ordinal);
        Assert.Contains("actions/runs/$runId", promote, StringComparison.Ordinal);
        Assert.Contains(".github/workflows/publish.yml", promote, StringComparison.Ordinal);
        Assert.Contains("download-artifact", promote, StringComparison.Ordinal);
        Assert.Contains("steps.artifact.outputs.credential_provider", promote, StringComparison.Ordinal);
        Assert.Contains("Validate credential provider registry", promote, StringComparison.Ordinal);
        Assert.Contains("vars.GHCR_PUBLISH_REGISTRY", promote, StringComparison.Ordinal);
        Assert.Contains("test \"$SELECTED_REGISTRY\" = \"$EXPECTED_REGISTRY\"", promote, StringComparison.Ordinal);
        Assert.Contains("github.token", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.HARBOR_PUBLISH_USERNAME", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.HARBOR_PUBLISH_TOKEN", promote, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets.HARBOR_USERNAME", promote, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets.HARBOR_TOKEN", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.DOCKERHUB_USERNAME", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.DOCKERHUB_TOKEN", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.REGISTRY_USERNAME", promote, StringComparison.Ordinal);
        Assert.Contains("secrets.REGISTRY_PASSWORD", promote, StringComparison.Ordinal);
        Assert.DoesNotContain("secrets[", promote, StringComparison.Ordinal);
        Assert.Contains("release-manifest.json", promote, StringComparison.Ordinal);
        Assert.Contains("\"schemaVersion\":2", publish, StringComparison.Ordinal);
        Assert.Contains("credentialProvider", publish, StringComparison.Ordinal);
        Assert.Contains("credentialProvider", promote, StringComparison.Ordinal);
        Assert.Contains("legacyCredentialProvider", promote, StringComparison.Ordinal);
        Assert.Contains("$manifest.schemaVersion -eq 1", promote, StringComparison.Ordinal);
        Assert.Contains("sourceCommit", promote, StringComparison.Ordinal);
        Assert.Contains("sha256:[a-f0-9]{64}", promote, StringComparison.Ordinal);
        Assert.Contains("image.digest", promote, StringComparison.Ordinal);
        Assert.Contains("HELM_VALUES_CONTENT", promote, StringComparison.Ordinal);
        Assert.Contains("kubectl get --raw /apis/monitoring.coreos.com/v1", promote, StringComparison.Ordinal);
        Assert.Contains("api_args+=(--api-versions", promote, StringComparison.Ordinal);
        Assert.DoesNotContain("$workflowRun.head_sha -ne $commit", promote, StringComparison.Ordinal);
        Assert.Contains("$ciRun.head_sha -ne $env:EXPECTED_COMMIT", promote, StringComparison.Ordinal);
        Assert.Contains("$ciRun.path -ne '.github/workflows/ci.yml'", promote, StringComparison.Ordinal);
        Assert.Contains("group: promote-${{ inputs.environment }}-${{ inputs.namespace }}-${{ inputs.releaseName }}", promote, StringComparison.Ordinal);
        Assert.Contains("cancel-in-progress: false", promote, StringComparison.Ordinal);
        Assert.Contains("ref: ${{ steps.release.outputs.commit }}", promote, StringComparison.Ordinal);
        Assert.Contains("publishRunId:\n        description:", promote.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Contains("publishRunId:\n        description: Trusted publish workflow run containing release evidence\n        required: false", promote.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Contains("--values", promote, StringComparison.Ordinal);
        Assert.Contains("deployment_name=$(awk", promote, StringComparison.Ordinal);
        Assert.Contains("--atomic --wait", promote, StringComparison.Ordinal);
    }

    [Fact]
    public void PackagePromotionUsesOneVerifiedImmutableCandidate()
    {
        var workflow = Read(".github/workflows/packages.yml");
        var releaseIntent = Read("scripts/Get-PackageReleaseIntent.ps1");
        var ciWorkflow = Read(".github/workflows/ci.yml");
        var build = Read("scripts/Build-RealtimePackages.ps1");
        var publish = Read("scripts/Publish-RealtimePackages.ps1");
        var props = Read("Directory.Build.props");
        var targets = Read("Directory.Build.targets");

        Assert.Contains("--locked-mode", build, StringComparison.Ordinal);
        Assert.Contains("Assert-Reproducible", build, StringComparison.Ordinal);
        Assert.DoesNotContain("createdUtc =", build, StringComparison.Ordinal);
        Assert.Contains("Test-AspNetCorePackage.ps1", build, StringComparison.Ordinal);
        Assert.Contains("Test-DotNetClientPackage.ps1", build, StringComparison.Ordinal);
        Assert.Contains("Test-BrowserPackage.ps1", build, StringComparison.Ordinal);
        Assert.Contains("sourceTree = if ($sourceDirty) { 'dirty' } else { 'clean' }", build, StringComparison.Ordinal);
        Assert.Contains("Directory.Build.props", build, StringComparison.Ordinal);
        Assert.DoesNotContain("[string]$ContractsVersion = '0.1.0'", build, StringComparison.Ordinal);
        Assert.Contains("<ProjectVersion>[$(ContractsVersion),$(ContractsCompatibilityUpperBound))</ProjectVersion>", targets, StringComparison.Ordinal);
        Assert.Contains("<ProjectVersion>[$(RedisAdapterVersion),$(RedisAdapterCompatibilityUpperBound))</ProjectVersion>", targets, StringComparison.Ordinal);
        Assert.Contains("$(PackageRepositoryUrl)", props, StringComparison.Ordinal);
        Assert.Contains("$(PackageReleaseNotesUrl)", props, StringComparison.Ordinal);
        Assert.DoesNotContain("github.com", props, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("environment: package-production", workflow, StringComparison.Ordinal);
        Assert.Contains("workflow_run:", workflow, StringComparison.Ordinal);
        Assert.Contains("workflows: [Realtime gateway CI]", workflow, StringComparison.Ordinal);
        Assert.Contains("WORKFLOW_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}", workflow, StringComparison.Ordinal);
        Assert.Contains("group: package-promotion-${{ github.repository }}-${{ needs['release-intent'].outputs.candidate_sha }}", workflow, StringComparison.Ordinal);
        Assert.Contains("cancel-in-progress: false", workflow, StringComparison.Ordinal);
        Assert.Contains("actions/attest-build-provenance@", workflow, StringComparison.Ordinal);
        Assert.Contains("Attest exact immutable package candidate", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("attest-candidate:", workflow, StringComparison.Ordinal);
        Assert.Contains("Generate package SBOM", workflow, StringComparison.Ordinal);
        Assert.Contains("Scan package candidate", workflow, StringComparison.Ordinal);
        Assert.Contains("actions: read", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("dotnet pack", workflow, StringComparison.Ordinal);
        Assert.Contains("resume_run_id:", workflow, StringComparison.Ordinal);
        Assert.Contains("Manual package publication is restricted to the main branch.", workflow, StringComparison.Ordinal);
        Assert.Contains("needs['release-intent'].outputs.should_publish == 'true'", workflow, StringComparison.Ordinal);
        Assert.Contains("needs['release-intent'].outputs.publish_npm", workflow, StringComparison.Ordinal);
        Assert.Contains("PROTECTED_NUGET_SOURCE: ${{ vars.NUGET_SOURCE }}", workflow, StringComparison.Ordinal);
        Assert.Contains("PROTECTED_NPM_REGISTRY: ${{ vars.NPM_REGISTRY }}", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("inputs.nuget_source", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("inputs.npm_registry", workflow, StringComparison.Ordinal);
        Assert.Contains("actions/workflows/ci.yml/runs?branch=main&head_sha=$env:EXPECTED_SHA", workflow, StringComparison.Ordinal);
        Assert.Contains("$prior.head_sha -ne $env:EXPECTED_SHA", workflow, StringComparison.Ordinal);
        Assert.Contains("$prior.event -notin @('workflow_dispatch', 'workflow_run')", workflow, StringComparison.Ordinal);
        Assert.Contains("include-hidden-files: true", workflow, StringComparison.Ordinal);
        Assert.Contains("${{ github.run_attempt }}", workflow, StringComparison.Ordinal);
        Assert.Contains("candidate_artifact_name", workflow, StringComparison.Ordinal);
        Assert.Contains("steps.resume.outputs.has_state", workflow, StringComparison.Ordinal);
        Assert.Contains("steps.resume.outputs.candidate_attempt", workflow, StringComparison.Ordinal);
        Assert.Contains("Download original resumable candidate", workflow, StringComparison.Ordinal);
        Assert.Contains("@parameters", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("@arguments", workflow, StringComparison.Ordinal);
        Assert.Contains("PACKAGE_REPOSITORY_URL", workflow, StringComparison.Ordinal);
        Assert.Contains("Get-PackageReleaseIntent.ps1 -PreviousRevision $parent", workflow, StringComparison.Ordinal);
        Assert.Contains("Every coordinated NuGet and npm package version must match", releaseIntent, StringComparison.Ordinal);
        Assert.Contains("A coordinated release must change every package version", releaseIntent, StringComparison.Ordinal);
        Assert.Contains("VersionChanged = $changed.Count -eq $current.Count", releaseIntent, StringComparison.Ordinal);
        Assert.Contains("'--source', $UpstreamPackageSource", build, StringComparison.Ordinal);
        Assert.Contains("always() && hashFiles('artifacts/cormier-realtime-gateway.tar.gz') != ''", ciWorkflow, StringComparison.Ordinal);

        Assert.Contains("SHA256SUMS disagrees with manifest.json", publish, StringComparison.Ordinal);
        Assert.Contains("manifestSha256", publish, StringComparison.Ordinal);
        Assert.Contains("Existing npm promotion state belongs to a different registry", publish, StringComparison.Ordinal);
        Assert.Contains("nugetPackageIdsInDependencyOrder", publish, StringComparison.Ordinal);
        var contractsOrder = publish.IndexOf("'Cormier.Realtime.Contracts'", StringComparison.Ordinal);
        var clientOrder = publish.IndexOf("'Cormier.Realtime.Client'", StringComparison.Ordinal);
        var redisOrder = publish.IndexOf("'Cormier.Realtime.Redis'", StringComparison.Ordinal);
        var aspNetCoreOrder = publish.IndexOf("'Cormier.Realtime.AspNetCore'", StringComparison.Ordinal);
        Assert.True(contractsOrder >= 0 && contractsOrder < clientOrder && contractsOrder < redisOrder);
        Assert.True(clientOrder < aspNetCoreOrder && redisOrder < aspNetCoreOrder);
        Assert.Contains("$symbolPackage.FullName", publish, StringComparison.Ordinal);
        Assert.Contains("'--no-symbols'", publish, StringComparison.Ordinal);
        Assert.Contains("{ 'next' } else { 'latest' }", publish, StringComparison.Ordinal);
        Assert.Contains("-split '\\+', 2", publish, StringComparison.Ordinal);
        Assert.Contains("'--tag', $npmTag", publish, StringComparison.Ordinal);
        Assert.Contains("Get-RegistryIdentity", publish, StringComparison.Ordinal);
        Assert.Contains("[StringComparer]::Ordinal.Equals", publish, StringComparison.Ordinal);
        Assert.True(
            publish.IndexOf("$npmToken = [Environment]::GetEnvironmentVariable", StringComparison.Ordinal) <
            publish.IndexOf("$phase = 'Publish NuGet'", StringComparison.Ordinal));
        Assert.Contains("SetUnixFileMode", publish, StringComparison.Ordinal);
        Assert.Contains("Duplicate versions are not skipped", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("--skip-duplicate", publish, StringComparison.OrdinalIgnoreCase);
    }

    private static string Read(string relative)
    {
        var normalizedRelative = relative.Replace('/', Path.DirectorySeparatorChar);
        if (Path.IsPathRooted(normalizedRelative))
        {
            throw new ArgumentException("Repository path must be relative.", nameof(relative));
        }

        return File.ReadAllText(Path.Join(Root, normalizedRelative));
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Join(current.FullName, "Cormier.Realtime.sln")))
        {
            current = current.Parent;
        }

        return current?.FullName ?? throw new DirectoryNotFoundException("Repository root not found.");
    }
}
