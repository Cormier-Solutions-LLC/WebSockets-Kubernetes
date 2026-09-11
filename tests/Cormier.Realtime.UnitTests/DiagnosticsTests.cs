using Cormier.Realtime.Gateway;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.FileProviders;

namespace Cormier.Realtime.UnitTests;

public sealed class DiagnosticsTests
{
    [Fact]
    public void RedactorRemovesCredentialsAndPrivateIdentityValues()
    {
        const string input = "Authorization: Bearer abc.def\nAuthorization Basic whitespace-basic\nCookie: theme=dark; sid=victim-secret\nCookie whitespace-cookie\ncookie=session-value ticket=one tenantId=tenant-a tenant_id=tenant-b user=user-a user_id=user-b session_id=session-b tenant structured-tenant password=hunter2 secret structured-secret access_token=oauth-secret client_secret=client-credential api-key=hyphen-credential api_key=underscore-credential clientSecret=camel-credential {\"Authorization\":\"Basic structured-basic\"}\n{\"Cookie\":\"structured-cookie\"}\n{\"Set-Cookie\":\"structured-set-cookie\"}\n{\"token\":\"json-secret\",\"sessionId\":\"json-session\"}\npassword \"correct horse battery staple\"; secret multi word credential";

        var output = DiagnosticRedactor.Redact(input);

        Assert.DoesNotContain("abc.def", output, StringComparison.Ordinal);
        Assert.DoesNotContain("session-value", output, StringComparison.Ordinal);
        Assert.DoesNotContain("tenant-a", output, StringComparison.Ordinal);
        Assert.DoesNotContain("tenant-b", output, StringComparison.Ordinal);
        Assert.DoesNotContain("user-a", output, StringComparison.Ordinal);
        Assert.DoesNotContain("user-b", output, StringComparison.Ordinal);
        Assert.DoesNotContain("session-b", output, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", output, StringComparison.Ordinal);
        Assert.DoesNotContain("json-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("json-session", output, StringComparison.Ordinal);
        Assert.DoesNotContain("structured-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("correct horse battery staple", output, StringComparison.Ordinal);
        Assert.DoesNotContain("multi word credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("victim-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("structured-tenant", output, StringComparison.Ordinal);
        Assert.DoesNotContain("oauth-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("client-credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("hyphen-credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("underscore-credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("camel-credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("structured-basic", output, StringComparison.Ordinal);
        Assert.DoesNotContain("structured-cookie", output, StringComparison.Ordinal);
        Assert.DoesNotContain("structured-set-cookie", output, StringComparison.Ordinal);
        Assert.DoesNotContain("whitespace-basic", output, StringComparison.Ordinal);
        Assert.DoesNotContain("whitespace-cookie", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", output, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeLogLevelRejectsNullJsonFieldsWithoutThrowing()
    {
        var controller = Controller(new DiagnosticsOptions());

        Assert.False(controller.TryApply(
            new LogLevelChangeRequest(null!, null!, 30, null!, null!),
            "operator",
            out _,
            out var error));
        Assert.Contains("required", error, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeLogLevelsAreValidatedScopedAndAudited()
    {
        var controller = Controller(new DiagnosticsOptions
        {
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });

        Assert.False(controller.TryApply(
            new LogLevelChangeRequest("Microsoft", "Trace", 10, "investigate"),
            "operator",
            out _,
            out _));
        Assert.False(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime", "None", 10, "investigate"),
            "operator",
            out _,
            out _));
        Assert.False(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime", "-1", 10, "investigate"),
            "operator",
            out _,
            out _));
        Assert.False(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime", "7", 10, "investigate"),
            "operator",
            out _,
            out _));
        Assert.False(controller.TryApply(
            new LogLevelChangeRequest($"Cormier.Realtime.{new string('x', 129)}", "Debug", 10, "investigate"),
            "operator",
            out _,
            out _));

        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 10, "investigate latency", "instance"),
            "operator",
            out var applied,
            out _));
        Assert.NotNull(applied);
        Assert.Equal(LogLevel.Debug, controller.EffectiveLevel("Cormier.Realtime.Redis.Worker"));
        Assert.False(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Trace", 10, "overlapping request", "instance"),
            "operator",
            out _,
            out var overlapError));
        Assert.Contains("already exists", overlapError, StringComparison.Ordinal);
        Assert.Equal(LogLevel.Information, controller.EffectiveLevel("Other"));
        Assert.Single(controller.GetAudit(0, 10));
        Assert.True(controller.Revert(applied.Id, "operator", "complete"));
        Assert.Equal(LogLevel.Information, controller.EffectiveLevel("Cormier.Realtime.Redis.Worker"));
        Assert.Equal(2, controller.AuditCount);
    }

    [Fact]
    public void RuntimeLogLevelAutomaticallyExpiresAndRedactsAuditValues()
    {
        var controller = Controller(new DiagnosticsOptions
        {
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });

        Assert.True(controller.TryApply(
            new LogLevelChangeRequest(
                "Cormier.Realtime.Redis",
                "Debug",
                1,
                "token=reason-secret investigate",
                "instance"),
            "token=actor-secret",
            out var applied,
            out _,
            startedAt: DateTimeOffset.UtcNow.AddSeconds(-2)));

        Assert.NotNull(applied);
        Assert.Empty(controller.GetActive());
        Assert.Equal(LogLevel.Information, controller.EffectiveLevel("Cormier.Realtime.Redis.Worker"));
        var audit = controller.GetAudit(0, 10);
        Assert.Contains(audit, item => item.Id == applied.Id && item.Outcome == "expired");
        Assert.All(audit, item =>
        {
            Assert.DoesNotContain("actor-secret", item.Actor, StringComparison.Ordinal);
            Assert.DoesNotContain("reason-secret", item.Reason, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task StreamHubKeepsSlowSubscribersBounded()
    {
        var hub = new DiagnosticsStreamHub();
        await using var subscription = hub.SubscribeLogs(2);
        for (var index = 0; index < 20; index++)
        {
            hub.Publish(new DiagnosticLogEvent(index, DateTimeOffset.UtcNow, "Information", "category", 0, null, "instance", index.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        var received = new List<DiagnosticLogEvent>();
        while (subscription.Reader.TryRead(out var item))
        {
            received.Add(item);
        }

        Assert.InRange(received.Count, 1, 2);
        Assert.Equal("19", received[^1].Message);
    }

    [Fact]
    public async Task DiagnosticsLoggerRedactsBeforePublishing()
    {
        var hub = new DiagnosticsStreamHub();
        await using var subscription = hub.SubscribeLogs(4);
        var identity = new DiagnosticsIdentity();
        using var provider = new DiagnosticsLoggerProvider(
            hub,
            Controller(new DiagnosticsOptions()),
            identity);
        var logger = provider.CreateLogger("Cormier.Realtime.Security");

        logger.Log(
            LogLevel.Warning,
            new EventId(1, "SensitiveFixture"),
            "Cookie whitespace-cookie tenantId=private-tenant",
            new InvalidOperationException("password=exception-credential"),
            static (state, _) => state);

        Assert.True(subscription.Reader.TryRead(out var item));
        Assert.DoesNotContain("credential", item.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("private-tenant", item.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("whitespace-cookie", item.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("exception-credential", item.Message, StringComparison.Ordinal);
        Assert.Contains(nameof(InvalidOperationException), item.Message, StringComparison.Ordinal);
        Assert.Equal(identity.InstanceId, item.InstanceId);
    }

    [Fact]
    public async Task DiagnosticsLoggerDefersToTheOuterProgrammaticBaselineWithoutAnOverride()
    {
        var hub = new DiagnosticsStreamHub();
        await using var subscription = hub.SubscribeLogs(4);
        using var provider = new DiagnosticsLoggerProvider(
            hub,
            Controller(new DiagnosticsOptions()),
            new DiagnosticsIdentity());
        using var factory = LoggerFactory.Create(builder =>
        {
            builder.ClearProviders();
            builder.SetMinimumLevel(LogLevel.Debug);
            builder.AddProvider(provider);
        });
        var logger = factory.CreateLogger("Cormier.Realtime.ProgrammaticBaseline");

        logger.Log(LogLevel.Debug, new EventId(2), "debug-visible", null, static (state, _) => state);

        Assert.True(subscription.Reader.TryRead(out var item));
        Assert.Equal("debug-visible", item.Message);
    }

    [Fact]
    public void TailAndRequestConcurrencyAreIndependentlyBounded()
    {
        using var limiter = new Cormier.Realtime.AspNetCore.DiagnosticsRequestLimiter(Options.Create(new DiagnosticsOptions
        {
            MaximumConcurrentRequests = 1,
            MaximumTailSessions = 1,
        }));
        using var request = limiter.TryAcquireRequest();
        using var tail = limiter.TryAcquireTail();

        Assert.NotNull(request);
        Assert.NotNull(tail);
        Assert.Null(limiter.TryAcquireRequest());
        Assert.Null(limiter.TryAcquireTail());
    }

    [Fact]
    public async Task OperationalEventsAreAggregateAndSampledUnderBurstLoad()
    {
        var hub = new DiagnosticsStreamHub();
        await using var subscription = hub.SubscribeEvents(8);
        using var metrics = new GatewayMetrics(new GatewayOptions(), hub, new DiagnosticsIdentity());

        Parallel.For(0, 100, _ => metrics.RecordMessage("inbound", "accepted"));

        var events = new List<DiagnosticOperationalEvent>();
        while (subscription.Reader.TryRead(out var item))
        {
            events.Add(item);
        }
        Assert.Single(events);
        Assert.Equal("message.throughput", events[0].Kind);
        Assert.InRange(events[0].Snapshot.Messages, 1, 100);
    }

    [Fact]
    public void ProductionRequiresSeparateDiagnosticsEnablementAcknowledgement()
    {
        var validator = new DiagnosticsEnvironmentValidator(new TestHostEnvironment
        {
            EnvironmentName = Environments.Production,
        });

        var rejected = validator.Validate(null, new DiagnosticsOptions { Enabled = true });
        var accepted = validator.Validate(null, new DiagnosticsOptions
        {
            Enabled = true,
            ProductionEnabled = true,
            AllowedNetworks = ["192.0.2.0/24"],
        });

        Assert.True(rejected.Failed);
        Assert.True(accepted.Succeeded);
    }

    [Fact]
    public async Task DisabledDiagnosticsDoNotPublishOperationalEvents()
    {
        var hub = new DiagnosticsStreamHub();
        await using var subscription = hub.SubscribeEvents(4);
        using var metrics = new GatewayMetrics(
            new GatewayOptions(),
            hub,
            new DiagnosticsIdentity(),
            diagnosticsEnabled: false);

        metrics.RecordMessage("inbound", "accepted");

        Assert.False(subscription.Reader.TryRead(out _));
    }

    [Fact]
    public void InstanceOverrideTakesPrecedenceOverReplicaWideOverrideForTheSameCategory()
    {
        var controller = Controller(new DiagnosticsOptions());
        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Warning", 30, "replica investigation", "all"),
            "operator",
            out _,
            out _));
        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Trace", 30, "instance investigation", "instance"),
            "operator",
            out _,
            out _));

        Assert.Equal(LogLevel.Trace, controller.EffectiveLevel("Cormier.Realtime.Redis.Connection"));
    }

    [Fact]
    public async Task ConcurrentInstanceOverridesReserveCategoryAndCapacityAtomically()
    {
        var duplicateController = Controller(new DiagnosticsOptions());
        var duplicateOutcomes = await Task.WhenAll(Enumerable.Range(0, 20).Select(index => Task.Run(() =>
            duplicateController.TryApply(
                new LogLevelChangeRequest("Cormier.Realtime.Concurrent", "Debug", 30, "concurrency verification", "instance"),
                "operator",
                out _,
                out _))));
        Assert.Single(duplicateOutcomes, succeeded => succeeded);

        var capacityController = Controller(new DiagnosticsOptions { MaximumDetailItems = 2 });
        var capacityOutcomes = await Task.WhenAll(Enumerable.Range(0, 20).Select(index => Task.Run(() =>
            capacityController.TryApply(
                new LogLevelChangeRequest($"Cormier.Realtime.Category{index}", "Debug", 30, "capacity verification", "instance"),
                "operator",
                out _,
                out _))));
        Assert.Equal(2, capacityOutcomes.Count(succeeded => succeeded));
        Assert.Equal(2, capacityController.GetActive().Length);

        Assert.True(capacityController.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.ReplicaWide", "Debug", 30, "replica capacity verification", "all"),
            "operator",
            out _,
            out _));
        Assert.Equal(3, capacityController.GetActive().Length);
    }

    [Fact]
    public void PersistingAnEvictedAuditEntryDoesNotDequeueANewerEntry()
    {
        var controller = Controller(new DiagnosticsOptions { AuditCapacity = 2 });
        foreach (var suffix in new[] { "One", "Two" })
        {
            Assert.True(controller.TryApply(
                new LogLevelChangeRequest($"Cormier.Realtime.{suffix}", "Debug", 30, "audit queue verification", "instance"),
                "operator",
                out _,
                out _));
        }
        Assert.True(controller.TryPeekPendingAudit(out var originallyPeeked));
        Assert.NotNull(originallyPeeked);
        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Three", "Debug", 30, "audit queue verification", "instance"),
            "operator",
            out _,
            out _));

        controller.MarkPendingAuditPersisted(originallyPeeked);

        Assert.True(controller.TryPeekPendingAudit(out var remaining));
        Assert.NotNull(remaining);
        Assert.Equal("Cormier.Realtime.Two", remaining.Category);
    }

    private static RuntimeLogLevelController Controller(DiagnosticsOptions options) => new(
        Options.Create(options),
        new DiagnosticsIdentity());

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Development;

        public string ApplicationName { get; set; } = "DiagnosticsTests";

        public string ContentRootPath { get; set; } = string.Empty;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
