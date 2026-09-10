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

    public int CloseTimeoutSeconds { get; set; } = 5;

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
        CloseTimeoutSeconds = CloseTimeoutSeconds,
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

    public ExponentialRealtimeRetryPolicy(RealtimeClientOptions options)
    {
        if (options is null)
        {
            throw new ArgumentNullException(nameof(options));
        }
        _initialDelayMilliseconds = options.InitialReconnectDelayMilliseconds;
        _maximumDelayMilliseconds = options.MaximumReconnectDelayMilliseconds;
    }

    public TimeSpan GetDelay(int attempt, RealtimeTransportClose? close)
    {
        if (attempt < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(attempt));
        }

        var multiplier = Math.Pow(2, Math.Min(attempt - 1, 30));
        var delay = Math.Min(_maximumDelayMilliseconds, _initialDelayMilliseconds * multiplier);
        return TimeSpan.FromMilliseconds(delay);
    }
}
