using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cormier.Realtime.Gateway;

public sealed class DiagnosticsIdentity
{
    private readonly string _instanceId;

    public DiagnosticsIdentity() : this(ResolveInstanceId())
    {
    }

    public DiagnosticsIdentity(string instanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        if (instanceId.Trim().Length > 128)
        {
            throw new ArgumentOutOfRangeException(nameof(instanceId), "The diagnostics instance identifier cannot exceed 128 characters.");
        }
        _instanceId = instanceId.Trim();
    }

    public string InstanceId => _instanceId;

    private static string ResolveInstanceId()
    {
        var configured = Environment.GetEnvironmentVariable("CORMIER_REALTIME_INSTANCE_ID");
        return string.IsNullOrWhiteSpace(configured) ? Environment.MachineName : configured.Trim();
    }
}

public sealed class DiagnosticsStreamHub
{
    private readonly ConcurrentDictionary<Guid, Channel<DiagnosticLogEvent>> _logs = new();
    private readonly ConcurrentDictionary<Guid, Channel<DiagnosticOperationalEvent>> _events = new();
    private long _logSequence;
    private long _eventSequence;

    public long NextLogSequence() => Interlocked.Increment(ref _logSequence);

    public long NextEventSequence() => Interlocked.Increment(ref _eventSequence);

    public DiagnosticSubscription<DiagnosticLogEvent> SubscribeLogs(int capacity) =>
        Subscribe(_logs, capacity);

    public DiagnosticSubscription<DiagnosticOperationalEvent> SubscribeEvents(int capacity) =>
        Subscribe(_events, capacity);

    public void Publish(DiagnosticLogEvent item) => Publish(_logs, item);

    public void Publish(DiagnosticOperationalEvent item) => Publish(_events, item);

    private static DiagnosticSubscription<T> Subscribe<T>(
        ConcurrentDictionary<Guid, Channel<T>> subscribers,
        int capacity)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<T>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest,
            AllowSynchronousContinuations = false,
        });
        subscribers[id] = channel;
        return new DiagnosticSubscription<T>(channel.Reader, () => subscribers.TryRemove(id, out _));
    }

    private static void Publish<T>(ConcurrentDictionary<Guid, Channel<T>> subscribers, T item)
    {
        foreach (var subscriber in subscribers.Values)
        {
            subscriber.Writer.TryWrite(item);
        }
    }
}

public sealed class DiagnosticSubscription<T>(ChannelReader<T> reader, Action unsubscribe) : IAsyncDisposable
{
    public ChannelReader<T> Reader { get; } = reader;

    public ValueTask DisposeAsync()
    {
        unsubscribe();
        return ValueTask.CompletedTask;
    }
}

public static partial class DiagnosticRedactor
{
    private const string Redacted = "[REDACTED]";

    [GeneratedRegex("(?im)\\b(authorization|cookie|set-cookie)[\"']?(?:\\s*[:=]\\s*|\\s+)[^\\r\\n]*", RegexOptions.CultureInvariant)]
    private static partial Regex HeaderPattern();

    [GeneratedRegex("(?i)\\b((?:(?:[a-z0-9]+[-_.])*(?:password|secret|token|ticket|key)|(?:access|refresh|client|api)(?:Password|Secret|Token|Ticket|Key)))[\"']?(?:\\s*[:=]\\s*|\\s+)(?:\"[^\"\\r\\n]*\"|'[^'\\r\\n]*'|[^\\r\\n,;}]+)", RegexOptions.CultureInvariant)]
    private static partial Regex SecretPattern();

    [GeneratedRegex("(?i)\\b(tenant|user|session)(?:[-_.]?id)?[\"']?(?:\\s*[:=]\\s*|\\s+)(?:\"[^\"\\r\\n]*\"|'[^'\\r\\n]*'|[^\\r\\n,;}]+)", RegexOptions.CultureInvariant)]
    private static partial Regex PrivateIdentityPattern();

    [GeneratedRegex("(?i)bearer\\s+[A-Za-z0-9._~+/-]+=*", RegexOptions.CultureInvariant)]
    private static partial Regex BearerPattern();

    public static string Redact(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        var redacted = HeaderPattern().Replace(value, match => $"{match.Groups[1].Value}={Redacted}");
        redacted = BearerPattern().Replace(redacted, $"Bearer {Redacted}");
        redacted = SecretPattern().Replace(redacted, match => $"{match.Groups[1].Value}={Redacted}");
        redacted = PrivateIdentityPattern().Replace(redacted, match => $"{match.Groups[1].Value}={Redacted}");
        return redacted;
    }

    public static string RedactBounded(string value, int maximumLength)
    {
        var redacted = Redact(value).Replace('\r', ' ').Replace('\n', ' ').Trim();
        return redacted.Length <= maximumLength ? redacted : redacted[..maximumLength];
    }
}

public sealed class RuntimeLogLevelController(
    IOptions<DiagnosticsOptions> options,
    DiagnosticsIdentity identity,
    IConfiguration? configuration = null)
{
    private readonly ConcurrentDictionary<string, ActiveLogLevelOverride> _overrides = new(StringComparer.Ordinal);
    private readonly object _overrideLock = new();
    private readonly ConcurrentQueue<LogLevelAuditEntry> _audit = new();
    private readonly Queue<LogLevelAuditEntry> _pendingAudit = new();
    private readonly object _pendingAuditLock = new();
    private readonly DiagnosticsOptions _options = options.Value;
    private readonly KeyValuePair<string, LogLevel>[] _baselineLevels = ReadBaselineLevels(configuration);

    public LogLevel EffectiveLevel(string category)
    {
        var now = DateTimeOffset.UtcNow;
        RemoveExpired(now);
        return EffectiveLevelCore(category, now);
    }

    public bool HasOverride(string category)
    {
        var now = DateTimeOffset.UtcNow;
        RemoveExpired(now);
        return _overrides.Values.Any(item => item.ExpiresAt > now &&
            CategoryMatches(item.Category, category));
    }

    private LogLevel EffectiveLevelCore(string category, DateTimeOffset now)
    {
        var selected = _overrides.Values
            .Where(item => item.ExpiresAt > now &&
                CategoryMatches(item.Category, category))
            .OrderByDescending(item => item.Category.Length)
            .ThenByDescending(item => item.Scope == "instance")
            .FirstOrDefault();
        return selected?.Level ?? BaselineLevel(category);
    }

    private static bool CategoryMatches(string configuredCategory, string category) =>
        configuredCategory == "*" ||
        category == configuredCategory ||
        category.StartsWith($"{configuredCategory}.", StringComparison.Ordinal);

    public LogLevelOverrideResponse[] GetActive()
    {
        RemoveExpired(DateTimeOffset.UtcNow);
        return _overrides.Values
            .OrderBy(item => item.ExpiresAt)
            .Select(ToResponse)
            .ToArray();
    }

    public LogLevelAuditEntry[] GetAudit(int offset, int limit) => _audit
        .Reverse()
        .Skip(offset)
        .Take(limit)
        .ToArray();

    public int AuditCount => _audit.Count;

    internal bool TryPeekPendingAudit(out LogLevelAuditEntry? entry)
    {
        lock (_pendingAuditLock)
        {
            entry = _pendingAudit.Count == 0 ? null : _pendingAudit.Peek();
            return entry is not null;
        }
    }

    internal void MarkPendingAuditPersisted(LogLevelAuditEntry persisted)
    {
        lock (_pendingAuditLock)
        {
            if (_pendingAudit.Count > 0 && _pendingAudit.Peek() == persisted)
            {
                _pendingAudit.Dequeue();
            }
        }
    }

    public bool Contains(string id)
    {
        RemoveExpired(DateTimeOffset.UtcNow);
        return _overrides.ContainsKey(id);
    }

    public bool TryApply(
        LogLevelChangeRequest request,
        string actor,
        out LogLevelOverrideResponse? response,
        out string error,
        string? id = null,
        DateTimeOffset? startedAt = null)
    {
        lock (_overrideLock)
        {
            return TryApplyLocked(request, actor, out response, out error, id, startedAt);
        }
    }

    private bool TryApplyLocked(
        LogLevelChangeRequest request,
        string actor,
        out LogLevelOverrideResponse? response,
        out string error,
        string? id,
        DateTimeOffset? startedAt)
    {
        response = null;
        if (!TryValidateLocked(request, out error))
        {
            return false;
        }

        var category = request.Category.Trim();
        _ = Enum.TryParse<LogLevel>(request.Level, true, out var level);
        var now = startedAt ?? DateTimeOffset.UtcNow;
        var changeId = id ?? Guid.NewGuid().ToString("N");
        if (_overrides.TryGetValue(changeId, out var existing))
        {
            response = ToResponse(existing);
            return true;
        }
        var previous = EffectiveLevel(category);
        var active = new ActiveLogLevelOverride(
            changeId,
            category,
            level,
            request.Scope,
            now,
            now.AddSeconds(request.DurationSeconds));
        _overrides[changeId] = active;
        AddAudit(new LogLevelAuditEntry(
            changeId,
            now,
            DiagnosticRedactor.RedactBounded(actor, 128),
            DiagnosticRedactor.RedactBounded(request.Reason, 256),
            category,
            previous.ToString(),
            level.ToString(),
            request.Scope,
            active.ExpiresAt,
            "applied",
            identity.InstanceId));
        response = ToResponse(active);
        return true;
    }

    internal bool TryValidate(LogLevelChangeRequest request, out string error)
    {
        lock (_overrideLock)
        {
            return TryValidateLocked(request, out error);
        }
    }

    private bool TryValidateLocked(LogLevelChangeRequest request, out string error)
    {
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(request.Category) ||
            string.IsNullOrWhiteSpace(request.Level) ||
            string.IsNullOrWhiteSpace(request.Reason) ||
            string.IsNullOrWhiteSpace(request.Scope))
        {
            error = "Category, level, reason, and scope are required.";
            return false;
        }

        var category = request.Category.Trim();
        if (category.Length is 0 or > 128 || !_options.LogCategoryAllowlist.Any(allowed =>
            allowed == "*" || category == allowed || category.StartsWith($"{allowed}.", StringComparison.Ordinal)))
        {
            error = "The requested category is not in the diagnostics allowlist.";
            return false;
        }
        if (!Enum.TryParse<LogLevel>(request.Level, true, out var level) ||
            !Enum.IsDefined(level) ||
            level is LogLevel.None)
        {
            error = "The requested log level is invalid.";
            return false;
        }
        if (request.DurationSeconds < _options.MinimumLogOverrideSeconds ||
            request.DurationSeconds > _options.MaximumLogOverrideSeconds)
        {
            error = $"Duration must be between {_options.MinimumLogOverrideSeconds} and {_options.MaximumLogOverrideSeconds} seconds.";
            return false;
        }
        if (request.Reason.Trim().Length is < 3 or > 256)
        {
            error = "A reason between 3 and 256 characters is required.";
            return false;
        }
        if (request.Scope is not ("all" or "instance"))
        {
            error = "Scope must be 'all' or 'instance'.";
            return false;
        }

        RemoveExpired(DateTimeOffset.UtcNow);
        if (request.Scope == "instance" &&
            _overrides.Values.Count(active => active.Scope == "instance") >= _options.MaximumDetailItems)
        {
            error = "The active diagnostics override limit has been reached.";
            return false;
        }
        if (_overrides.Values.Any(active =>
            active.Category == category && active.Scope == request.Scope && active.ExpiresAt > DateTimeOffset.UtcNow))
        {
            error = "An active override already exists for the requested category and scope.";
            return false;
        }

        return true;
    }

    public bool Revert(string id, string actor, string reason)
    {
        if (!_overrides.TryRemove(id, out var active))
        {
            return false;
        }

        AddAudit(new LogLevelAuditEntry(
            active.Id,
            DateTimeOffset.UtcNow,
            DiagnosticRedactor.RedactBounded(actor, 128),
            DiagnosticRedactor.RedactBounded(reason, 256),
            active.Category,
            active.Level.ToString(),
            EffectiveLevel(active.Category).ToString(),
            active.Scope,
            active.ExpiresAt,
            "reverted",
            identity.InstanceId));
        return true;
    }

    private void RemoveExpired(DateTimeOffset now)
    {
        foreach (var active in _overrides.Values
                     .Where(active => active.ExpiresAt <= now)
                     .Where(active => _overrides.TryRemove(active.Id, out _)))
        {
            AddAudit(new LogLevelAuditEntry(
                active.Id,
                now,
                "system",
                "automatic expiry",
                active.Category,
                active.Level.ToString(),
                EffectiveLevelCore(active.Category, now).ToString(),
                active.Scope,
                active.ExpiresAt,
                "expired",
                identity.InstanceId));
        }
    }

    private void AddAudit(LogLevelAuditEntry entry)
    {
        _audit.Enqueue(entry);
        lock (_pendingAuditLock)
        {
            _pendingAudit.Enqueue(entry);
            while (_pendingAudit.Count > _options.AuditCapacity)
            {
                _pendingAudit.Dequeue();
            }
        }
        while (_audit.Count > _options.AuditCapacity)
        {
            _audit.TryDequeue(out _);
        }
    }

    private static LogLevelOverrideResponse ToResponse(ActiveLogLevelOverride active) => new(
        active.Id,
        active.Category,
        active.Level.ToString(),
        active.Scope,
        active.StartedAt,
        active.ExpiresAt,
        "active");

    private LogLevel BaselineLevel(string category) => _baselineLevels
        .Where(item => item.Key == "Default" || category == item.Key || category.StartsWith($"{item.Key}.", StringComparison.Ordinal))
        .OrderByDescending(item => item.Key == "Default" ? 0 : item.Key.Length)
        .Select(item => item.Value)
        .FirstOrDefault(LogLevel.Information);

    private static KeyValuePair<string, LogLevel>[] ReadBaselineLevels(IConfiguration? configuration)
    {
        if (configuration is null)
        {
            return [new("Default", LogLevel.Information)];
        }
        var levels = configuration.GetSection("Logging:LogLevel").GetChildren()
            .Select(item => new KeyValuePair<string, LogLevel>(
                item.Key,
                Enum.TryParse<LogLevel>(item.Value, true, out var level) ? level : LogLevel.Information))
            .ToArray();
        return levels.Length == 0 ? [new("Default", LogLevel.Information)] : levels;
    }

    private sealed record ActiveLogLevelOverride(
        string Id,
        string Category,
        LogLevel Level,
        string Scope,
        DateTimeOffset StartedAt,
        DateTimeOffset ExpiresAt);
}

public sealed class DiagnosticsLoggerProvider(
    DiagnosticsStreamHub hub,
    RuntimeLogLevelController levels,
    DiagnosticsIdentity identity,
    IOptions<DiagnosticsOptions>? options = null) : ILoggerProvider
{
    private readonly bool _enabled = options?.Value.Enabled ?? true;

    public ILogger CreateLogger(string categoryName) => new DiagnosticsLogger(categoryName, hub, levels, identity, _enabled);

    public void Dispose()
    {
    }

    private sealed class DiagnosticsLogger(
        string category,
        DiagnosticsStreamHub hub,
        RuntimeLogLevelController levels,
        DiagnosticsIdentity identity,
        bool enabled) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => enabled &&
            (!levels.HasOverride(category) || logLevel >= levels.EffectiveLevel(category));

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            var formatted = formatter(state, exception);
            var message = DiagnosticRedactor.RedactBounded(
                exception is null ? formatted : $"{formatted}{Environment.NewLine}{exception}",
                8192);
            hub.Publish(new DiagnosticLogEvent(
                hub.NextLogSequence(),
                DateTimeOffset.UtcNow,
                logLevel.ToString(),
                category,
                eventId.Id,
                Activity.Current?.TraceId.ToString(),
                identity.InstanceId,
                message));
        }
    }
}

public sealed class DiagnosticsSamplerService(
    DiagnosticsStreamHub hub,
    GatewayMetrics metrics,
    DiagnosticsIdentity identity,
    RuntimeLogLevelController levels,
    IOptions<DiagnosticsOptions> options) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled)
        {
            return;
        }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            _ = levels.GetActive();
            hub.Publish(new DiagnosticOperationalEvent(
                "1.0",
                hub.NextEventSequence(),
                DateTimeOffset.UtcNow,
                "gateway.snapshot",
                identity.InstanceId,
                metrics.Snapshot()));
        }
    }
}
