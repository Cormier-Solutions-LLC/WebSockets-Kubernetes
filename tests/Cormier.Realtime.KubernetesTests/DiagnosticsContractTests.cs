using System.Text.Json;
using System.Diagnostics.Metrics;
using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.KubernetesTests;

public sealed class DiagnosticsContractTests
{
    private static readonly string Root = FindRepositoryRoot();
    private static readonly string[] MetricTypes = ["counter", "gauge", "histogram"];

    [Fact]
    public void PortableMetricsCatalogIsVersionedBoundedAndMatchesExposition()
    {
        using var catalog = JsonDocument.Parse(Read("observability/metrics-catalog.json"));
        Assert.Matches("^[1-9][0-9]*\\.[0-9]+\\.[0-9]+$", catalog.RootElement.GetProperty("contractVersion").GetString());
        var prohibited = catalog.RootElement.GetProperty("prohibitedLabels")
            .EnumerateArray().Select(item => item.GetString()).ToHashSet(StringComparer.Ordinal);
        var catalogNames = catalog.RootElement.GetProperty("metrics").EnumerateArray()
            .Select(metric => metric.GetProperty("name").GetString())
            .Where(name => name is not null)
            .Cast<string>()
            .ToHashSet(StringComparer.Ordinal);
        using var metrics = new GatewayMetrics();
        var exposition = metrics.RenderPrometheus();

        foreach (var metric in catalog.RootElement.GetProperty("metrics").EnumerateArray())
        {
            var name = metric.GetProperty("name").GetString();
            Assert.False(string.IsNullOrWhiteSpace(name));
            Assert.Contains(name!, exposition, StringComparison.Ordinal);
            Assert.Contains(metric.GetProperty("type").GetString(), MetricTypes);
            if (metric.GetProperty("type").GetString() == "histogram")
            {
                Assert.NotEmpty(metric.GetProperty("buckets").EnumerateArray());
            }
            Assert.False(string.IsNullOrWhiteSpace(metric.GetProperty("unit").GetString()));
            Assert.True(metric.GetProperty("cardinalityBudget").GetInt32() > 0);
            Assert.False(string.IsNullOrWhiteSpace(metric.GetProperty("source").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(metric.GetProperty("aggregation").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(metric.GetProperty("temporality").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(metric.GetProperty("stability").GetString()));
            Assert.NotEmpty(metric.GetProperty("availability").EnumerateArray());
            Assert.NotEmpty(metric.GetProperty("consumers").EnumerateArray());
            Assert.DoesNotContain(metric.GetProperty("labels").EnumerateArray(), label => prohibited.Contains(label.GetString()));
        }
        var exposedNames = exposition.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith("# HELP ", StringComparison.Ordinal))
            .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries)[2]);
        Assert.All(exposedNames, name => Assert.Contains(name, catalogNames));
    }

    [Fact]
    public void OtlpInstrumentNamesMatchCatalogAvailability()
    {
        var instruments = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, meterListener) =>
            {
                if (instrument.Meter.Name == "Cormier.Realtime.Gateway")
                {
                    instruments.Add(instrument.Name);
                    meterListener.EnableMeasurementEvents(instrument);
                }
            },
        };
        listener.Start();
        using var metrics = new GatewayMetrics();
        using var catalog = JsonDocument.Parse(Read("observability/metrics-catalog.json"));

        var otlpNames = catalog.RootElement.GetProperty("metrics")
            .EnumerateArray()
            .Where(metric => metric.GetProperty("availability").EnumerateArray()
                .Any(value => value.GetString() == "otlp"))
            .Select(metric => metric.GetProperty("name").GetString()!);

        Assert.All(otlpNames, name => Assert.Contains(name, instruments));
    }

    [Fact]
    public void ChartKeepsDiagnosticsDisabledAndTelemetryCredentialsSecretBacked()
    {
        var values = Read("helm/realtime-gateway/values.yaml");
        var config = Read("helm/realtime-gateway/templates/configmap.yaml");
        var deployment = Read("helm/realtime-gateway/templates/deployment.yaml");
        var monitor = Read("helm/realtime-gateway/templates/servicemonitor.yaml");

        Assert.Contains("diagnostics:\n  enabled: false", values.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Contains("Diagnostics__ProductionEnabled", config, StringComparison.Ordinal);
        Assert.Contains("Diagnostics__AuthorizationPolicy", config, StringComparison.Ordinal);
        Assert.Contains("Metrics__OtlpEnabled", config, StringComparison.Ordinal);
        Assert.Contains("OTEL_EXPORTER_OTLP_HEADERS", deployment, StringComparison.Ordinal);
        Assert.Contains("Diagnostics__OperatorToken", deployment, StringComparison.Ordinal);
        Assert.Contains(".Values.diagnostics.operatorTokenSecret.name", deployment, StringComparison.Ordinal);
        Assert.Contains("secretKeyRef", deployment, StringComparison.Ordinal);
        Assert.DoesNotContain("OTEL_EXPORTER_OTLP_HEADERS:", config, StringComparison.Ordinal);
        Assert.DoesNotContain("Diagnostics__OperatorToken", config, StringComparison.Ordinal);
        Assert.Contains(".Values.metrics.path", monitor, StringComparison.Ordinal);
        Assert.Contains("authorization:", monitor, StringComparison.Ordinal);
        Assert.Contains(".Values.diagnostics.operatorTokenSecret.name", monitor, StringComparison.Ordinal);
        Assert.Contains("CORMIER_REALTIME_INSTANCE_ID", deployment, StringComparison.Ordinal);
    }

    [Fact]
    public void CollectorExamplesAreBoundedAndCredentialFree()
    {
        var collector = Read("observability/otel-collector.example.yaml");
        var prometheus = Read("observability/prometheus.example.yaml");
        var conformanceCollector = Read("observability/conformance/collector.yaml");
        var conformanceBackend = Read("observability/conformance/backend.yaml");
        var conformancePrometheus = Read("observability/conformance/prometheus.yaml");
        var conformanceScript = Read("scripts/verify-observability.sh");

        Assert.Contains("memory_limiter", collector, StringComparison.Ordinal);
        Assert.Contains("batch", collector, StringComparison.Ordinal);
        Assert.Contains("drop-private-attributes", collector, StringComparison.Ordinal);
        Assert.Contains("${env:OTEL_EXPORTER_OTLP_HEADERS_AUTHORIZATION}", collector, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer ", collector, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("scrape_timeout", prometheus, StringComparison.Ordinal);
        Assert.Contains("metrics_path: /metrics", prometheus, StringComparison.Ordinal);
        Assert.Contains("otlphttp/backend", conformanceCollector, StringComparison.Ordinal);
        Assert.Contains("memory_limiter", conformanceCollector, StringComparison.Ordinal);
        Assert.Contains("receivers: [otlp]", conformanceBackend, StringComparison.Ordinal);
        Assert.Contains("job_name: otlp-backend", conformancePrometheus, StringComparison.Ordinal);
        Assert.Contains("docker stop", conformanceScript, StringComparison.Ordinal);
        Assert.Contains("before_interruption + 5", conformanceScript, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer ", conformanceCollector, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CleanPackageConsumerLocksPortableTelemetryAndLinuxRestore()
    {
        using var packageLock = JsonDocument.Parse(Read("examples/full-circle/package-consumer.packages.lock.json"));
        var dependencies = packageLock.RootElement.GetProperty("dependencies");
        var portable = dependencies.GetProperty("net10.0");

        Assert.True(dependencies.TryGetProperty("net10.0/linux-x64", out _));
        Assert.True(portable.TryGetProperty("OpenTelemetry.Exporter.OpenTelemetryProtocol", out _));
        Assert.True(portable.TryGetProperty("OpenTelemetry.Extensions.Hosting", out _));
        Assert.True(portable.GetProperty("Cormier.Realtime.AspNetCore")
            .GetProperty("dependencies")
            .TryGetProperty("OpenTelemetry.Exporter.OpenTelemetryProtocol", out _));
    }

    private static string Read(string relative) =>
        File.ReadAllText(Path.Join(Root, relative.Replace('/', Path.DirectorySeparatorChar)));

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Join(current.FullName, "Cormier.Realtime.sln")))
        {
            current = current.Parent;
        }
        return current?.FullName ?? throw new DirectoryNotFoundException("Repository root was not found.");
    }
}
