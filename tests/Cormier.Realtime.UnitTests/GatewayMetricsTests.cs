using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.UnitTests;

public sealed class GatewayMetricsTests
{
    [Fact]
    public void ExporterPreservesBoundedDimensionsAndNeverEmitsCallerValues()
    {
        using var metrics = new GatewayMetrics();
        metrics.RecordAuthentication(false, "attacker-controlled");
        metrics.RecordAuthorizationFailure("tenant/secret/topic");
        metrics.RecordMessage("tenant-123", "user-456");
        metrics.RecordRedisOperation("key-name", false);
        metrics.RecordCloseCode(4008);
        metrics.RecordHandlerDuration("dispatch", TimeSpan.FromMilliseconds(12), "success");

        var rendered = metrics.RenderPrometheus();
        Assert.Contains("method=\"other\"", rendered, StringComparison.Ordinal);
        Assert.Contains("operation=\"other\"", rendered, StringComparison.Ordinal);
        Assert.Contains("direction=\"other\",outcome=\"other\"", rendered, StringComparison.Ordinal);
        Assert.Contains("code=\"4008\"", rendered, StringComparison.Ordinal);
        Assert.Contains("le=\"0.025\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("attacker-controlled", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("tenant/secret/topic", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("tenant-123", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void QueueAccountingReturnsToZeroAndDistinguishesClosedSocketsFromSaturation()
    {
        using var metrics = new GatewayMetrics();
        metrics.RecordQueueEnqueued();
        metrics.RecordQueueRemoved(1);
        var rendered = metrics.RenderPrometheus();
        Assert.Contains("cormier_realtime_queue_depth 0", rendered, StringComparison.Ordinal);
        Assert.Contains("cormier_realtime_queue_dropped_total 0", rendered, StringComparison.Ordinal);
    }
}
