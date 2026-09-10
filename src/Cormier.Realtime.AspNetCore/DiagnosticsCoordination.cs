using System.Text.Json;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class DiagnosticsControlService(
    RuntimeLogLevelController controller,
    RedisConnectionProvider redis,
    RedisOptions redisOptions,
    IOptions<DiagnosticsOptions> options)
{
    private readonly DiagnosticsOptions _options = options.Value;

    public async ValueTask<(bool Succeeded, LogLevelOverrideResponse? Result, string Error)> ApplyAsync(
        LogLevelChangeRequest request,
        string actor,
        CancellationToken cancellationToken)
    {
        actor = DiagnosticRedactor.RedactBounded(actor, 128);
        request = request with
        {
            Category = request.Category?.Trim() ?? string.Empty,
            Level = request.Level?.Trim() ?? string.Empty,
            Reason = DiagnosticRedactor.RedactBounded(request.Reason ?? string.Empty, 256),
            Scope = request.Scope?.Trim() ?? string.Empty,
        };
        var id = Guid.NewGuid().ToString("N");
        var startedAt = DateTimeOffset.UtcNow;
        if (!controller.TryApply(request, actor, out var result, out var error, id, startedAt))
        {
            return (false, null, error);
        }
        if (request.Scope == "all")
        {
            IDatabase? database = null;
            string? key = null;
            try
            {
                var connection = await redis.GetConnectionAsync(cancellationToken);
                if (!connection.IsConnected)
                {
                    controller.Revert(id, "system", "coordination failure rollback");
                    return (false, null, "Replica-wide changes require an available Redis coordination service.");
                }
                database = connection.GetDatabase();
                var message = new DiagnosticsCoordinationMessage("apply", id, request, actor, startedAt);
                var payload = JsonSerializer.Serialize(
                    message,
                    DiagnosticsJsonSerializerContext.Default.DiagnosticsCoordinationMessage);
                key = ActiveKey(id);
                await database.StringSetAsync(key, payload, TimeSpan.FromSeconds(request.DurationSeconds));
                await database.SortedSetAddAsync(
                    ActiveIndexKey(),
                    id,
                    startedAt.AddSeconds(request.DurationSeconds).ToUnixTimeMilliseconds());
                await connection.GetSubscriber().PublishAsync(
                    RedisChannel.Literal($"{redisOptions.InstancePrefix}:{_options.CoordinationChannel}"),
                    payload);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                if (database is not null && key is not null)
                {
                    await RemoveActiveAsync(database, id, key);
                }
                controller.Revert(id, "system", "cancelled coordination rollback");
                throw;
            }
            catch (RedisException)
            {
                if (database is not null && key is not null)
                {
                    try
                    {
                        await RemoveActiveAsync(database, id, key);
                    }
                    catch (RedisException)
                    {
                        // The key is TTL-bounded and will expire even if cleanup cannot reach Redis.
                    }
                }
                controller.Revert(id, "system", "coordination failure rollback");
                return (false, null, "Replica-wide changes require an available Redis coordination service.");
            }
        }
        await FlushLocalAuditAsync(cancellationToken);
        return (true, result, string.Empty);
    }

    public async ValueTask<bool> RevertAsync(string id, string actor, CancellationToken cancellationToken)
    {
        actor = DiagnosticRedactor.RedactBounded(actor, 128);
        var active = controller.GetActive().FirstOrDefault(item => item.Id == id);
        if (active is null)
        {
            return false;
        }
        var coordinationPublished = false;
        if (active.Scope == "all")
        {
            try
            {
                var connection = await redis.GetConnectionAsync(cancellationToken);
                if (!connection.IsConnected)
                {
                    return false;
                }
                var database = connection.GetDatabase();
                var message = new DiagnosticsCoordinationMessage("revert", id, null, actor, DateTimeOffset.UtcNow);
                var payload = JsonSerializer.Serialize(
                    message,
                    DiagnosticsJsonSerializerContext.Default.DiagnosticsCoordinationMessage);
                await RemoveActiveAsync(database, id, ActiveKey(id));
                await connection.GetSubscriber().PublishAsync(
                    RedisChannel.Literal($"{redisOptions.InstancePrefix}:{_options.CoordinationChannel}"),
                    payload);
                coordinationPublished = true;
            }
            catch (RedisException)
            {
                return false;
            }
        }
        // The local subscriber can process the published rollback before this call.
        var reverted = controller.Revert(id, actor, "manual rollback") || coordinationPublished;
        if (reverted)
        {
            await FlushLocalAuditAsync(cancellationToken);
        }
        return reverted;
    }

    public async ValueTask<LogLevelAuditPage> GetAuditAsync(int offset, int limit, CancellationToken cancellationToken)
    {
        await FlushLocalAuditAsync(cancellationToken);
        try
        {
            var connection = redis.CurrentConnection;
            if (connection is null || !connection.IsConnected)
            {
                return LocalAuditPage(offset, limit);
            }
            var values = await connection.GetDatabase().ListRangeAsync(AuditKey(), offset, offset + limit - 1);
            var items = values
                .Select(value =>
                {
                    try
                    {
                        return JsonSerializer.Deserialize(
                            value.ToString(),
                            DiagnosticsJsonSerializerContext.Default.LogLevelAuditEntry);
                    }
                    catch (JsonException)
                    {
                        return null;
                    }
                })
                .Where(item => item is not null)
                .Cast<LogLevelAuditEntry>()
                .ToArray();
            var total = (int)Math.Min(int.MaxValue, await connection.GetDatabase().ListLengthAsync(AuditKey()));
            return new LogLevelAuditPage(DateTimeOffset.UtcNow, offset, limit, total, items);
        }
        catch (RedisException)
        {
            return LocalAuditPage(offset, limit);
        }
    }

    internal async ValueTask FlushLocalAuditAsync(CancellationToken cancellationToken)
    {
        _ = controller.GetActive();
        try
        {
            var connection = redis.CurrentConnection;
            if (connection is null || !connection.IsConnected)
            {
                return;
            }
            var database = connection.GetDatabase();
            var retention = TimeSpan.FromDays(_options.AuditRetentionDays);
            await database.SortedSetRemoveRangeByScoreAsync(
                ActiveIndexKey(),
                double.NegativeInfinity,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            foreach (var entry in controller.GetAudit(0, _options.AuditCapacity).Reverse())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var payload = JsonSerializer.Serialize(
                    entry,
                    DiagnosticsJsonSerializerContext.Default.LogLevelAuditEntry);
                var transaction = database.CreateTransaction();
                transaction.AddCondition(Condition.KeyNotExists(AuditDedupeKey(entry)));
                var mark = transaction.StringSetAsync(AuditDedupeKey(entry), "1", retention);
                var push = transaction.ListLeftPushAsync(AuditKey(), payload);
                var trim = transaction.ListTrimAsync(AuditKey(), 0, _options.AuditCapacity - 1);
                var expire = transaction.KeyExpireAsync(AuditKey(), retention);
                if (await transaction.ExecuteAsync())
                {
                    await Task.WhenAll(mark, push, trim, expire);
                }
            }
        }
        catch (RedisException)
        {
            // The bounded in-memory audit remains available during a Redis interruption.
        }
    }

    private string AuditKey() =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:audit";

    private string AuditDedupeKey(LogLevelAuditEntry entry) =>
        $"{AuditKey()}:entry:{entry.Id}:{entry.Timestamp.UtcTicks}:{entry.Outcome}:{entry.InstanceId}";

    private string ActiveKey(string id) =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:active:{id}";

    private string ActiveIndexKey() =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:active-index";

    private async Task RemoveActiveAsync(IDatabase database, string id, string key)
    {
        await database.KeyDeleteAsync(key);
        await database.SortedSetRemoveAsync(ActiveIndexKey(), id);
    }

    private LogLevelAuditPage LocalAuditPage(int offset, int limit) => new(
        DateTimeOffset.UtcNow,
        offset,
        limit,
        controller.AuditCount,
        controller.GetAudit(offset, limit));
}

public sealed class DiagnosticsAuditPersistenceService(
    DiagnosticsControlService control,
    IOptions<DiagnosticsOptions> options) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled)
        {
            return;
        }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (!stoppingToken.IsCancellationRequested)
        {
            await control.FlushLocalAuditAsync(stoppingToken);
            if (!await timer.WaitForNextTickAsync(stoppingToken))
            {
                return;
            }
        }
    }
}

public sealed class DiagnosticsCoordinationService(
    RuntimeLogLevelController controller,
    RedisConnectionProvider redis,
    RedisOptions redisOptions,
    IOptions<DiagnosticsOptions> options,
    ILogger<DiagnosticsCoordinationService> logger) : BackgroundService
{
    private static readonly Action<ILogger, Exception?> LogUnavailable = LoggerMessage.Define(
        LogLevel.Warning,
        new EventId(3101, "DiagnosticsCoordinationUnavailable"),
        "Diagnostics coordination is unavailable; retrying");
    private static readonly Action<ILogger, Exception?> LogInvalidMessage = LoggerMessage.Define(
        LogLevel.Warning,
        new EventId(3102, "DiagnosticsCoordinationInvalidMessage"),
        "Rejected an invalid diagnostics coordination message");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled)
        {
            return;
        }

        var channel = RedisChannel.Literal($"{redisOptions.InstancePrefix}:{options.Value.CoordinationChannel}");
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var connection = await redis.GetConnectionAsync(stoppingToken);
                var subscriber = connection.GetSubscriber();
                await RestoreActiveAsync(connection.GetDatabase(), stoppingToken);
                await subscriber.SubscribeAsync(channel, (_, value) => ApplyMessage(value));
                await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (RedisException exception)
            {
                LogUnavailable(logger, exception);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private async Task RestoreActiveAsync(IDatabase database, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var indexKey = ActiveIndexKey();
        await database.SortedSetRemoveRangeByScoreAsync(indexKey, double.NegativeInfinity, now);
        var ids = await database.SortedSetRangeByScoreAsync(indexKey, now, double.PositiveInfinity);
        foreach (var id in ids)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var value = await database.StringGetAsync(ActiveKey(id.ToString()));
            if (value.HasValue)
            {
                ApplyMessage(value);
            }
            else
            {
                await database.SortedSetRemoveAsync(indexKey, id);
            }
        }
    }

    private string ActiveKey(string id) =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{options.Value.CoordinationChannel}:active:{id}";

    private string ActiveIndexKey() =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{options.Value.CoordinationChannel}:active-index";

    private void ApplyMessage(RedisValue value)
    {
        try
        {
            var message = JsonSerializer.Deserialize(
                value.ToString(),
                DiagnosticsJsonSerializerContext.Default.DiagnosticsCoordinationMessage);
            if (message is null)
            {
                return;
            }
            if (message.Action == "revert")
            {
                controller.Revert(message.Id, message.Actor, "coordinated rollback");
            }
            else if (message.Action == "apply" && message.Request is not null && !controller.Contains(message.Id))
            {
                if (message.Timestamp.AddSeconds(message.Request.DurationSeconds) > DateTimeOffset.UtcNow)
                {
                    controller.TryApply(
                        message.Request,
                        message.Actor,
                        out _,
                        out _,
                        message.Id,
                        message.Timestamp);
                }
            }
        }
        catch (JsonException exception)
        {
            LogInvalidMessage(logger, exception);
        }
    }
}
