using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class DiagnosticsControlService(
    RuntimeLogLevelController controller,
    RedisConnectionProvider redis,
    RedisOptions redisOptions,
    IOptions<DiagnosticsOptions> options) : IDisposable
{
    private readonly DiagnosticsOptions _options = options.Value;
    private readonly SemaphoreSlim _auditFlush = new(1, 1);

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
                var reservationKey = ReservationKey(request.Category);
                var lifetime = TimeSpan.FromSeconds(request.DurationSeconds);
                var transaction = database.CreateTransaction();
                transaction.AddCondition(Condition.KeyNotExists(reservationKey));
                var activeWrite = transaction.StringSetAsync(key, payload, lifetime);
                var reservationWrite = transaction.StringSetAsync(reservationKey, id, lifetime);
                var indexWrite = transaction.SortedSetAddAsync(
                    ActiveIndexKey(), id, startedAt.Add(lifetime).ToUnixTimeMilliseconds());
                if (!await transaction.ExecuteAsync())
                {
                    controller.Revert(id, "system", "coordination conflict rollback");
                    return (false, null, "An active replica-wide override already exists for the requested category.");
                }
                await activeWrite;
                await reservationWrite;
                await indexWrite;
                await connection.GetSubscriber().PublishAsync(
                    RedisChannel.Literal($"{redisOptions.InstancePrefix}:{_options.CoordinationChannel}"),
                    payload);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                if (database is not null && key is not null)
                {
                    await RemoveActiveAsync(database, id, key, ReservationKey(request.Category));
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
                        await RemoveActiveAsync(database, id, key, ReservationKey(request.Category));
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
                await RemoveActiveAsync(database, id, ActiveKey(id), ReservationKey(active.Category));
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
            var values = await connection.GetDatabase().SortedSetRangeByRankAsync(
                AuditKey(), offset, offset + limit - 1, Order.Descending);
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
            var total = (int)Math.Min(int.MaxValue, await connection.GetDatabase().SortedSetLengthAsync(AuditKey()));
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
        if (!await _auditFlush.WaitAsync(0, cancellationToken))
        {
            return;
        }
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
            var auditCutoff = DateTimeOffset.UtcNow.Subtract(retention).ToUnixTimeMilliseconds();
            await database.SortedSetRemoveRangeByScoreAsync(AuditKey(), double.NegativeInfinity, auditCutoff);
            while (controller.TryPeekPendingAudit(out var entry) && entry is not null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var payload = JsonSerializer.Serialize(
                    entry,
                    DiagnosticsJsonSerializerContext.Default.LogLevelAuditEntry);
                await database.ScriptEvaluateAsync(
                    "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]); " +
                    "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3]); " +
                    "local count = redis.call('ZCARD', KEYS[1]); " +
                    "local capacity = tonumber(ARGV[4]); " +
                    "if count > capacity then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - capacity - 1); end; " +
                    "return 1;",
                    [AuditKey()],
                    [entry.Timestamp.ToUnixTimeMilliseconds(), payload, auditCutoff, _options.AuditCapacity]);
                controller.MarkPendingAuditPersisted();
            }
        }
        catch (RedisException)
        {
            // The bounded in-memory audit remains available during a Redis interruption.
        }
        finally
        {
            _auditFlush.Release();
        }
    }

    private string AuditKey() =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:audit";

    private string ActiveKey(string id) =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:active:{id}";

    private string ActiveIndexKey() =>
        $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:active-index";

    private string ReservationKey(string category)
    {
        var categoryHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(category)));
        return $"{redisOptions.InstancePrefix}:{{diagnostics}}:{_options.CoordinationChannel}:reservation:{categoryHash}";
    }

    private async Task RemoveActiveAsync(IDatabase database, string id, string key, string reservationKey)
    {
        await database.ScriptEvaluateAsync(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); end; " +
            "redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[3], ARGV[1]); return 1;",
            [reservationKey, key, ActiveIndexKey()],
            [id]);
    }

    private LogLevelAuditPage LocalAuditPage(int offset, int limit) => new(
        DateTimeOffset.UtcNow,
        offset,
        limit,
        controller.AuditCount,
        controller.GetAudit(offset, limit));

    public void Dispose() => _auditFlush.Dispose();
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
            ISubscriber? subscriber = null;
            IConnectionMultiplexer? connection = null;
            Task? periodicReconciliation = null;
            using var cycleCancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            var work = Channel.CreateBounded<CoordinationWork>(new BoundedChannelOptions(256)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.DropOldest,
            });
            EventHandler<ConnectionFailedEventArgs> restored = (_, _) =>
                work.Writer.TryWrite(new CoordinationWork(default, true));
            try
            {
                connection = await redis.GetConnectionAsync(stoppingToken);
                subscriber = connection.GetSubscriber();
                connection.ConnectionRestored += restored;
                await subscriber.SubscribeAsync(channel, (_, value) =>
                    work.Writer.TryWrite(new CoordinationWork(value, false)));
                work.Writer.TryWrite(new CoordinationWork(default, true));
                periodicReconciliation = QueuePeriodicReconciliationAsync(work.Writer, cycleCancellation.Token);
                await foreach (var item in work.Reader.ReadAllAsync(stoppingToken))
                {
                    if (item.Reconcile)
                    {
                        await ReconcileActiveAsync(connection.GetDatabase(), stoppingToken);
                    }
                    else
                    {
                        ApplyMessage(item.Message);
                    }
                }
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
            finally
            {
                cycleCancellation.Cancel();
                if (connection is not null)
                {
                    connection.ConnectionRestored -= restored;
                }
                if (subscriber is not null)
                {
                    try
                    {
                        await subscriber.UnsubscribeAsync(channel);
                    }
                    catch (RedisException)
                    {
                        // The next cycle establishes a fresh subscription.
                    }
                }
                if (periodicReconciliation is not null)
                {
                    try
                    {
                        await periodicReconciliation;
                    }
                    catch (OperationCanceledException) when (cycleCancellation.IsCancellationRequested)
                    {
                        // Cycle cancellation terminates the periodic producer.
                    }
                }
            }
        }
    }

    private async Task ReconcileActiveAsync(IDatabase database, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var indexKey = ActiveIndexKey();
        await database.SortedSetRemoveRangeByScoreAsync(indexKey, double.NegativeInfinity, now);
        var ids = await database.SortedSetRangeByScoreAsync(indexKey, now, double.PositiveInfinity);
        var activeMessages = new List<RedisValue>(ids.Length);
        var activeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in ids)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var value = await database.StringGetAsync(ActiveKey(id.ToString()));
            if (value.HasValue)
            {
                activeMessages.Add(value);
                activeIds.Add(id.ToString());
            }
            else
            {
                await database.SortedSetRemoveAsync(indexKey, id);
            }
        }
        foreach (var local in controller.GetActive().Where(item => item.Scope == "all" && !activeIds.Contains(item.Id)))
        {
            controller.Revert(local.Id, "system", "coordination reconciliation");
        }
        foreach (var value in activeMessages)
        {
            ApplyMessage(value);
        }
    }

    private static async Task QueuePeriodicReconciliationAsync(
        ChannelWriter<CoordinationWork> writer,
        CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            writer.TryWrite(new CoordinationWork(default, true));
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
            else if (message.Action == "apply" &&
                message.Request is not null &&
                !controller.Contains(message.Id) &&
                message.Timestamp.AddSeconds(message.Request.DurationSeconds) > DateTimeOffset.UtcNow)
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
        catch (JsonException exception)
        {
            LogInvalidMessage(logger, exception);
        }
    }

    private readonly record struct CoordinationWork(RedisValue Message, bool Reconcile);
}
