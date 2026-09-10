namespace Cormier.Realtime.Client;

public sealed class RealtimeClientOptions
{
    public Uri? Endpoint { get; set; }

    public string SubProtocol { get; set; } = "cormier.realtime.v1";

    public int MaximumFrameBytes { get; set; } = 16 * 1024;

    public int MaximumMessageBytes { get; set; } = 64 * 1024;

    public int SendQueueCapacity { get; set; } = 128;

    public int ReceiveQueueCapacity { get; set; } = 128;

    public int MaximumSubscriptions { get; set; } = 64;

    public int HeartbeatSeconds { get; set; } = 15;

    public int MaximumReconnectAttempts { get; set; } = 8;

    public int InitialReconnectDelayMilliseconds { get; set; } = 250;

    public int MaximumReconnectDelayMilliseconds { get; set; } = 30_000;

    public double ReconnectJitterRatio { get; set; } = 0.2;

    public int CloseTimeoutSeconds { get; set; } = 5;

    public bool AllowInsecureCredentialTransport { get; set; }

    internal RealtimeClientOptions Snapshot() => new()
    {
        Endpoint = Endpoint,
        SubProtocol = SubProtocol,
        MaximumFrameBytes = MaximumFrameBytes,
        MaximumMessageBytes = MaximumMessageBytes,
        SendQueueCapacity = SendQueueCapacity,
        ReceiveQueueCapacity = ReceiveQueueCapacity,
        MaximumSubscriptions = MaximumSubscriptions,
        HeartbeatSeconds = HeartbeatSeconds,
        MaximumReconnectAttempts = MaximumReconnectAttempts,
        InitialReconnectDelayMilliseconds = InitialReconnectDelayMilliseconds,
        MaximumReconnectDelayMilliseconds = MaximumReconnectDelayMilliseconds,
        ReconnectJitterRatio = ReconnectJitterRatio,
        CloseTimeoutSeconds = CloseTimeoutSeconds,
        AllowInsecureCredentialTransport = AllowInsecureCredentialTransport,
    };

    internal void Validate()
    {
        if (Endpoint is null || !Endpoint.IsAbsoluteUri ||
            (Endpoint.Scheme != "ws" && Endpoint.Scheme != "wss"))
        {
            throw new ArgumentException("Endpoint must be an absolute ws or wss URI.", nameof(Endpoint));
        }
        if (string.IsNullOrWhiteSpace(SubProtocol) || SubProtocol.Length > 128)
        {
            throw new ArgumentException("SubProtocol is required and must not exceed 128 characters.", nameof(SubProtocol));
        }
        if (MaximumFrameBytes < 1024 || MaximumFrameBytes > 1_048_576)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumFrameBytes));
        }
        if (MaximumMessageBytes < MaximumFrameBytes || MaximumMessageBytes > 4_194_304)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumMessageBytes));
        }
        if (SendQueueCapacity < 1 || SendQueueCapacity > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(SendQueueCapacity));
        }
        if (ReceiveQueueCapacity < 1 || ReceiveQueueCapacity > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(ReceiveQueueCapacity));
        }
        if (MaximumSubscriptions < 1 || MaximumSubscriptions > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumSubscriptions));
        }
        if (HeartbeatSeconds < 5 || HeartbeatSeconds > 300)
        {
            throw new ArgumentOutOfRangeException(nameof(HeartbeatSeconds));
        }
        if (MaximumReconnectAttempts < 0 || MaximumReconnectAttempts > 1_000)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumReconnectAttempts));
        }
        if (InitialReconnectDelayMilliseconds < 0 ||
            MaximumReconnectDelayMilliseconds < InitialReconnectDelayMilliseconds ||
            MaximumReconnectDelayMilliseconds > 300_000)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumReconnectDelayMilliseconds));
        }
        if (double.IsNaN(ReconnectJitterRatio) ||
            ReconnectJitterRatio < 0 ||
            ReconnectJitterRatio > 1)
        {
            throw new ArgumentOutOfRangeException(nameof(ReconnectJitterRatio));
        }
        if (CloseTimeoutSeconds < 1 || CloseTimeoutSeconds > 30)
        {
            throw new ArgumentOutOfRangeException(nameof(CloseTimeoutSeconds));
        }
    }
}

public sealed class ExponentialRealtimeRetryPolicy : IRealtimeRetryPolicy
{
    private readonly int _initialDelayMilliseconds;
    private readonly int _maximumDelayMilliseconds;
    private readonly double _jitterRatio;
    private readonly IRealtimeRandom _random;

    public ExponentialRealtimeRetryPolicy(
        RealtimeClientOptions options,
        IRealtimeRandom? random = null)
    {
        if (options is null)
        {
            throw new ArgumentNullException(nameof(options));
        }
        _initialDelayMilliseconds = options.InitialReconnectDelayMilliseconds;
        _maximumDelayMilliseconds = options.MaximumReconnectDelayMilliseconds;
        _jitterRatio = options.ReconnectJitterRatio;
        _random = random ?? SystemRealtimeRandom.Instance;
    }

    public TimeSpan GetDelay(int attempt, RealtimeTransportClose? close)
    {
        if (attempt < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(attempt));
        }

        var initial = close?.Reconnect?.InitialDelayMilliseconds ?? _initialDelayMilliseconds;
        var maximum = close?.Reconnect?.MaximumDelayMilliseconds ?? _maximumDelayMilliseconds;
        var delay = initial == 0 && maximum > 0
            ? attempt == 1 ? 0 : Math.Min(maximum, Math.Pow(2, Math.Min(attempt - 2, 30)))
            : Math.Min(maximum, initial * Math.Pow(2, Math.Min(attempt - 1, 30)));
        var jitterRatio = close?.Reconnect?.JitterRatio ?? _jitterRatio;
        if (jitterRatio > 0)
        {
            var factor = 1 + (((_random.NextDouble() * 2) - 1) * jitterRatio);
            delay = Math.Max(0, Math.Min(maximum, delay * factor));
        }
        return TimeSpan.FromMilliseconds(delay);
    }
}
