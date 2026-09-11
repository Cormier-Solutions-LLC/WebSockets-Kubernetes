using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Cormier.Realtime.IntegrationTests;

public sealed class DiagnosticsRedisTests
{
    private static string Endpoint =>
        Environment.GetEnvironmentVariable("REDIS_TEST_ENDPOINT") ?? "host.docker.internal:16379";

    [Fact]
    public async Task ReplicaWideOverridesAreReservedAtomicallyAndPeriodicallyReconciled()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var firstRedis = new RedisConnectionProvider(redisOptions);
        await using var secondRedis = new RedisConnectionProvider(redisOptions);
        var first = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("reservation-first"));
        var second = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("reservation-second"));
        var firstCoordination = new DiagnosticsCoordinationService(
            first, firstRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);
        var secondCoordination = new DiagnosticsCoordinationService(
            second, secondRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);
        var firstControl = new DiagnosticsControlService(first, firstRedis, redisOptions, diagnostics);
        var secondControl = new DiagnosticsControlService(second, secondRedis, redisOptions, diagnostics);

        await firstCoordination.StartAsync(CancellationToken.None);
        await secondCoordination.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntilAsync(() => firstRedis.CurrentConnection?.IsConnected == true &&
                secondRedis.CurrentConnection?.IsConnected == true);
            var request = new LogLevelChangeRequest(
                "Cormier.Realtime.Redis", "Debug", 30, "concurrent reservation verification", "all");
            var outcomes = await Task.WhenAll(
                firstControl.ApplyAsync(request, "operator-one", CancellationToken.None).AsTask(),
                secondControl.ApplyAsync(request, "operator-two", CancellationToken.None).AsTask());
            var winner = Assert.Single(outcomes, outcome => outcome.Succeeded);
            Assert.Single(outcomes, outcome => !outcome.Succeeded);
            Assert.NotNull(winner.Result);
            var loserIndex = Array.FindIndex(outcomes, outcome => !outcome.Succeeded);
            var loserController = loserIndex == 0 ? first : second;
            var loserActor = loserIndex == 0 ? "operator-one" : "operator-two";
            Assert.DoesNotContain(loserController.GetAudit(0, 20), item => item.Actor == loserActor);
            await WaitUntilAsync(() => first.Contains(winner.Result.Id) && second.Contains(winner.Result.Id));

            var database = firstRedis.CurrentConnection!.GetDatabase();
            var activeKey = $"{redisOptions.InstancePrefix}:{{diagnostics}}:{diagnostics.Value.CoordinationChannel}:active:{winner.Result.Id}";
            var indexKey = $"{redisOptions.InstancePrefix}:{{diagnostics}}:{diagnostics.Value.CoordinationChannel}:active-index";
            await database.KeyDeleteAsync(activeKey);
            await database.SortedSetRemoveAsync(indexKey, winner.Result.Id);

            await WaitUntilAsync(() => !first.Contains(winner.Result.Id) && !second.Contains(winner.Result.Id));
        }
        finally
        {
            await firstCoordination.StopAsync(CancellationToken.None);
            await secondCoordination.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task ReplicaWideCapacityIsReservedAtomicallyAcrossDistinctCategories()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MaximumDetailItems = 1,
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var firstRedis = new RedisConnectionProvider(redisOptions);
        await using var secondRedis = new RedisConnectionProvider(redisOptions);
        using var firstControl = new DiagnosticsControlService(
            new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("capacity-first")),
            firstRedis,
            redisOptions,
            diagnostics);
        using var secondControl = new DiagnosticsControlService(
            new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("capacity-second")),
            secondRedis,
            redisOptions,
            diagnostics);

        var outcomes = await Task.WhenAll(
            firstControl.ApplyAsync(
                new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 30, "global capacity one", "all"),
                "operator-one",
                CancellationToken.None).AsTask(),
            secondControl.ApplyAsync(
                new LogLevelChangeRequest("Cormier.Realtime.Gateway", "Debug", 30, "global capacity two", "all"),
                "operator-two",
                CancellationToken.None).AsTask());

        Assert.Single(outcomes, outcome => outcome.Succeeded);
        Assert.Single(outcomes, outcome => !outcome.Succeeded && outcome.Error.Contains("limit", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ConcurrentInstanceChangesArePersistedBeforeTheyReturn()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        var connection = await redis.GetConnectionAsync(CancellationToken.None);
        using var control = new DiagnosticsControlService(
            new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("concurrent-audit")),
            redis,
            redisOptions,
            diagnostics);

        var outcomes = await Task.WhenAll(Enumerable.Range(0, 16).Select(index =>
            control.ApplyAsync(
                new LogLevelChangeRequest(
                    $"Cormier.Realtime.Audit{index}",
                    "Debug",
                    30,
                    $"concurrent audit {index}",
                    "instance"),
                $"operator-{index}",
                CancellationToken.None).AsTask()));

        Assert.All(outcomes, outcome => Assert.True(outcome.Succeeded, outcome.Error));
        var auditKey = $"{redisOptions.InstancePrefix}:{{diagnostics}}:{diagnostics.Value.CoordinationChannel}:audit";
        Assert.Equal(outcomes.Length, await connection.GetDatabase().SortedSetLengthAsync(auditKey));
    }

    [Fact]
    public async Task InstanceScopedOverridesCanBeRevertedThroughAnotherReplica()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var firstRedis = new RedisConnectionProvider(redisOptions);
        await using var secondRedis = new RedisConnectionProvider(redisOptions);
        var first = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("instance-owner"));
        var second = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("instance-router"));
        using var firstControl = new DiagnosticsControlService(first, firstRedis, redisOptions, diagnostics);
        using var secondControl = new DiagnosticsControlService(second, secondRedis, redisOptions, diagnostics);
        var firstCoordination = new DiagnosticsCoordinationService(
            first, firstRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);
        var secondCoordination = new DiagnosticsCoordinationService(
            second, secondRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);

        await firstCoordination.StartAsync(CancellationToken.None);
        await secondCoordination.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntilAsync(() => firstRedis.CurrentConnection?.IsConnected == true &&
                secondRedis.CurrentConnection?.IsConnected == true);
            var applied = await firstControl.ApplyAsync(
                new LogLevelChangeRequest(
                    "Cormier.Realtime.Redis",
                    "Debug",
                    30,
                    "targeted rollback verification",
                    "instance"),
                "operator",
                CancellationToken.None);

            Assert.True(applied.Succeeded, applied.Error);
            Assert.True(first.Contains(applied.Result!.Id));
            Assert.False(second.Contains(applied.Result.Id));

            var reverted = await secondControl.RevertAsync(
                applied.Result.Id,
                "operator",
                CancellationToken.None);

            Assert.True(reverted.Found);
            Assert.True(reverted.Succeeded, reverted.Error);
            await WaitUntilAsync(() => !first.Contains(applied.Result.Id));
        }
        finally
        {
            await firstCoordination.StopAsync(CancellationToken.None);
            await secondCoordination.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task InstanceScopedApplyFailsClosedWhenCoordinationIsRequired()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = "redis.invalid:6379",
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 100,
            RequiredForReadiness = true,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        var controller = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("required-coordination"));
        using var control = new DiagnosticsControlService(controller, redis, redisOptions, diagnostics);

        var outcome = await control.ApplyAsync(
            new LogLevelChangeRequest(
                "Cormier.Realtime.Redis",
                "Debug",
                30,
                "required coordination verification",
                "instance"),
            "operator",
            CancellationToken.None);

        Assert.False(outcome.Succeeded);
        Assert.Contains("Redis", outcome.Error, StringComparison.Ordinal);
        Assert.Empty(controller.GetActive());
    }

    [Fact]
    public async Task MalformedCoordinationMessagesDoNotStopValidProcessing()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        var controller = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("invalid-message"));
        var coordination = new DiagnosticsCoordinationService(
            controller,
            redis,
            redisOptions,
            diagnostics,
            NullLogger<DiagnosticsCoordinationService>.Instance);
        await coordination.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntilAsync(() => redis.CurrentConnection?.IsConnected == true);
            var subscriber = redis.CurrentConnection!.GetSubscriber();
            var channel = RedisChannel.Literal($"{redisOptions.InstancePrefix}:{diagnostics.Value.CoordinationChannel}");
            await subscriber.PublishAsync(
                channel,
                "{\"action\":\"revert\",\"id\":null,\"request\":null,\"actor\":\"attacker\",\"timestamp\":\"2026-01-01T00:00:00Z\"}");
            await Task.Delay(100);

            var id = Guid.NewGuid().ToString("N");
            var valid = new DiagnosticsCoordinationMessage(
                "apply",
                id,
                new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 30, "valid message verification", "all"),
                "operator",
                DateTimeOffset.UtcNow);
            var payload = System.Text.Json.JsonSerializer.Serialize(
                valid,
                DiagnosticsJsonSerializerContext.Default.DiagnosticsCoordinationMessage);
            await subscriber.PublishAsync(channel, payload);

            await WaitUntilAsync(() => controller.Contains(id));
            Assert.False(coordination.ExecuteTask?.IsFaulted);
        }
        finally
        {
            await coordination.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task AuditPersistenceRemovesEntriesIndividuallyByAge()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
            AuditRetentionDays = 1,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        _ = await redis.GetConnectionAsync(CancellationToken.None);
        var controller = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("retention-instance"));
        using var control = new DiagnosticsControlService(controller, redis, redisOptions, diagnostics);
        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 1, "retention verification", "instance"),
            "retention-operator",
            out var applied,
            out _,
            startedAt: DateTimeOffset.UtcNow.AddDays(-2)));

        _ = await control.GetAuditAsync(0, 10, CancellationToken.None);
        var audit = await control.GetAuditAsync(0, 10, CancellationToken.None);
        var auditKey = $"{redisOptions.InstancePrefix}:{{diagnostics}}:{diagnostics.Value.CoordinationChannel}:audit";
        var auditTtl = await redis.CurrentConnection!.GetDatabase().KeyTimeToLiveAsync(auditKey);

        Assert.NotNull(applied);
        Assert.NotNull(auditTtl);
        Assert.InRange(auditTtl.Value, TimeSpan.Zero, TimeSpan.FromDays(1));
        Assert.DoesNotContain(audit.Items, item => item.Id == applied.Id && item.Outcome == "applied");
        Assert.Contains(audit.Items, item => item.Id == applied.Id && item.Outcome == "expired");
    }

    [Fact]
    public async Task ReplicaWideRevertReportsCoordinationOutageSeparatelyFromUnknownId()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = "redis.invalid:6379",
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 100,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        var controller = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("outage-instance"));
        using var control = new DiagnosticsControlService(controller, redis, redisOptions, diagnostics);
        Assert.True(controller.TryApply(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 30, "outage verification", "all"),
            "operator",
            out var active,
            out _));

        var outage = await control.RevertAsync(active!.Id, "operator", CancellationToken.None);
        var unknown = await control.RevertAsync(new string('a', 32), "operator", CancellationToken.None);

        Assert.True(outage.Found);
        Assert.False(outage.Succeeded);
        Assert.Contains("Redis", outage.Error, StringComparison.Ordinal);
        Assert.False(unknown.Found);
    }

    [Fact]
    public async Task CancelledInstanceApplyRollsBackTheLocalOverride()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = "redis.invalid:6379",
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 100,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var redis = new RedisConnectionProvider(redisOptions);
        var controller = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("cancelled-instance"));
        using var control = new DiagnosticsControlService(controller, redis, redisOptions, diagnostics);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => control.ApplyAsync(
            new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 30, "cancel rollback verification", "instance"),
            "operator",
            cancellation.Token).AsTask());

        Assert.Empty(controller.GetActive());
    }

    [Fact]
    public async Task LogLevelChangesCoordinateAuditAndRollbackAcrossInstances()
    {
        var redisOptions = new RedisOptions
        {
            Endpoint = Endpoint,
            InstancePrefix = $"cormier:test:diagnostics:{Guid.NewGuid():N}",
            ConnectTimeoutMilliseconds = 1000,
        };
        var diagnostics = Options.Create(new DiagnosticsOptions
        {
            Enabled = true,
            LogCategoryAllowlist = ["Cormier.Realtime"],
            MinimumLogOverrideSeconds = 1,
            MaximumLogOverrideSeconds = 60,
        });
        await using var firstRedis = new RedisConnectionProvider(redisOptions);
        await using var secondRedis = new RedisConnectionProvider(redisOptions);
        var first = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("diagnostics-first"));
        var second = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("diagnostics-second"));
        var firstCoordination = new DiagnosticsCoordinationService(
            first, firstRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);
        var secondCoordination = new DiagnosticsCoordinationService(
            second, secondRedis, redisOptions, diagnostics, NullLogger<DiagnosticsCoordinationService>.Instance);
        var firstControl = new DiagnosticsControlService(first, firstRedis, redisOptions, diagnostics);
        var secondControl = new DiagnosticsControlService(second, secondRedis, redisOptions, diagnostics);

        await firstCoordination.StartAsync(CancellationToken.None);
        await secondCoordination.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntilAsync(() => firstRedis.CurrentConnection?.IsConnected == true &&
                secondRedis.CurrentConnection?.IsConnected == true);
            await Task.Delay(100);
            var applied = await firstControl.ApplyAsync(
                new LogLevelChangeRequest("Cormier.Realtime.Redis", "Debug", 30, "multi-instance verification", "all"),
                "integration-operator",
                CancellationToken.None);

            Assert.True(applied.Succeeded, applied.Error);
            Assert.NotNull(applied.Result);
            await WaitUntilAsync(() => second.Contains(applied.Result.Id));
            Assert.Equal(Microsoft.Extensions.Logging.LogLevel.Debug, second.EffectiveLevel("Cormier.Realtime.Redis.Worker"));

            await using var restartedRedis = new RedisConnectionProvider(redisOptions);
            var restarted = new RuntimeLogLevelController(diagnostics, new DiagnosticsIdentity("diagnostics-restarted"));
            var restartedCoordination = new DiagnosticsCoordinationService(
                restarted,
                restartedRedis,
                redisOptions,
                diagnostics,
                NullLogger<DiagnosticsCoordinationService>.Instance);
            await restartedCoordination.StartAsync(CancellationToken.None);
            try
            {
                await WaitUntilAsync(() => restarted.Contains(applied.Result.Id));
                Assert.Equal(
                    Microsoft.Extensions.Logging.LogLevel.Debug,
                    restarted.EffectiveLevel("Cormier.Realtime.Redis.Worker"));

                var audit = await secondControl.GetAuditAsync(0, 10, CancellationToken.None);
                Assert.Contains(audit.Items, item => item.Id == applied.Result.Id && item.Outcome == "applied");
                Assert.Contains(audit.Items, item => item.Id == applied.Result.Id &&
                    item.Outcome == "applied" && item.InstanceId == "diagnostics-first");
                Assert.Contains(audit.Items, item => item.Id == applied.Result.Id &&
                    item.Outcome == "applied" && item.InstanceId == "diagnostics-second");

                var restartedControl = new DiagnosticsControlService(restarted, restartedRedis, redisOptions, diagnostics);
                var restartedAudit = await restartedControl.GetAuditAsync(0, 10, CancellationToken.None);
                Assert.Contains(restartedAudit.Items, item => item.Id == applied.Result.Id &&
                    item.Outcome == "applied" && item.InstanceId == "diagnostics-restarted");

                var missedController = new RuntimeLogLevelController(
                    diagnostics,
                    new DiagnosticsIdentity("diagnostics-missed-publication"));
                using var missedControl = new DiagnosticsControlService(
                    missedController,
                    firstRedis,
                    redisOptions,
                    diagnostics);
                var reverted = await missedControl.RevertAsync(
                    applied.Result.Id,
                    "integration-operator",
                    CancellationToken.None);
                Assert.True(reverted.Succeeded, reverted.Error);
                await WaitUntilAsync(() => !second.Contains(applied.Result.Id) && !restarted.Contains(applied.Result.Id));
                Assert.Equal(
                    Microsoft.Extensions.Logging.LogLevel.Information,
                    second.EffectiveLevel("Cormier.Realtime.Redis.Worker"));

                var expiring = await firstControl.ApplyAsync(
                    new LogLevelChangeRequest(
                        "Cormier.Realtime.Redis",
                        "Trace",
                        1,
                        "automatic expiry verification",
                        "all"),
                    "integration-operator",
                    CancellationToken.None);
                Assert.True(expiring.Succeeded, expiring.Error);
                await Task.Delay(TimeSpan.FromMilliseconds(1100));
                Assert.False(first.Contains(expiring.Result!.Id));
                _ = await firstControl.GetAuditAsync(0, 20, CancellationToken.None);
                var activeIndex = $"{redisOptions.InstancePrefix}:{{diagnostics}}:{diagnostics.Value.CoordinationChannel}:active-index";
                Assert.Null(await firstRedis.CurrentConnection!.GetDatabase()
                    .SortedSetScoreAsync(activeIndex, expiring.Result.Id));
                var persistedExpiry = await secondControl.GetAuditAsync(0, 20, CancellationToken.None);
                Assert.Contains(persistedExpiry.Items, item => item.Id == expiring.Result.Id &&
                    item.Outcome == "expired" && item.InstanceId == "diagnostics-first");
            }
            finally
            {
                await restartedCoordination.StopAsync(CancellationToken.None);
            }
        }
        finally
        {
            await firstCoordination.StopAsync(CancellationToken.None);
            await secondCoordination.StopAsync(CancellationToken.None);
        }
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            if (predicate())
            {
                return;
            }
            await Task.Delay(50);
        }
        Assert.Fail("Timed out waiting for coordinated diagnostics state.");
    }
}
