using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Cormier.Realtime.IntegrationTests;

public sealed class DiagnosticsRedisTests
{
    private static string Endpoint =>
        Environment.GetEnvironmentVariable("REDIS_TEST_ENDPOINT") ?? "host.docker.internal:16379";

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

                Assert.True(await firstControl.RevertAsync(
                    applied.Result.Id,
                    "integration-operator",
                    CancellationToken.None));
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
        for (var attempt = 0; attempt < 100; attempt++)
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
