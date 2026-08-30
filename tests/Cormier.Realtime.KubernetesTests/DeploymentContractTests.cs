namespace Cormier.Realtime.KubernetesTests;

public sealed class DeploymentContractTests
{
    private static readonly string Root = FindRepositoryRoot();

    [Fact]
    public void GatewayChartContainsRequiredWorkloadControls()
    {
        var deployment = Read("helm/realtime-gateway/templates/deployment.yaml");

        Assert.Contains("runAsNonRoot: true", deployment, StringComparison.Ordinal);
        Assert.Contains("readOnlyRootFilesystem: true", deployment, StringComparison.Ordinal);
        Assert.Contains("allowPrivilegeEscalation: false", deployment, StringComparison.Ordinal);
        Assert.Contains("capabilities: { drop: [\"ALL\"] }", deployment, StringComparison.Ordinal);
        Assert.Contains("automountServiceAccountToken:", deployment, StringComparison.Ordinal);
        Assert.Contains("startupProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("readinessProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("livenessProbe:", deployment, StringComparison.Ordinal);
        Assert.Contains("topologySpreadConstraints:", deployment, StringComparison.Ordinal);
        Assert.Contains("resources:", deployment, StringComparison.Ordinal);
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
        Assert.Contains("flushInterval: -1", route, StringComparison.Ordinal);
        Assert.Contains("realtime.cormier.local", gatewayValues, StringComparison.Ordinal);
        Assert.Contains("externalTrafficPolicy: Local", traefikValues, StringComparison.Ordinal);
        Assert.Contains("replicas: 3", traefikValues, StringComparison.Ordinal);
        Assert.Contains("defaultMode: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("RequestPath: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("RequestPort: drop", traefikValues, StringComparison.Ordinal);
        Assert.Contains("external-dns.alpha.kubernetes.io/hostname: realtime.cormier.local", traefikValues, StringComparison.Ordinal);
        Assert.Contains("prometheus:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("idletimeout=120s", traefikValues, StringComparison.Ordinal);
        Assert.Contains("topologySpreadConstraints:", traefikValues, StringComparison.Ordinal);
        Assert.Contains("development-traefik", metalLb, StringComparison.Ordinal);
        Assert.Contains("kind: L2Advertisement", metalLb, StringComparison.Ordinal);
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
        Assert.Contains("REALTIME_EDGE_TICKET", script, StringComparison.Ordinal);
        Assert.Contains("Invalid route is rejected", script, StringComparison.Ordinal);
        Assert.DoesNotContain("Write-Host $ticket", script, StringComparison.Ordinal);
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
