using System.Collections.ObjectModel;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.Client;

public enum RealtimeClientState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Stopping,
    Faulted,
}

public enum RealtimeClientLogLevel
{
    Trace,
    Information,
    Warning,
    Error,
}

public interface IRealtimeClientLogger
{
    void Log(RealtimeClientLogLevel level, int eventId, string message);
}

public sealed class NullRealtimeClientLogger : IRealtimeClientLogger
{
    public static NullRealtimeClientLogger Instance { get; } = new();

    private NullRealtimeClientLogger()
    {
    }

    public void Log(RealtimeClientLogLevel level, int eventId, string message)
    {
    }
}

public interface IRealtimeClientClock
{
    DateTimeOffset UtcNow { get; }

    Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken);
}

public sealed class SystemRealtimeClientClock : IRealtimeClientClock
{
    public static SystemRealtimeClientClock Instance { get; } = new();

    private SystemRealtimeClientClock()
    {
    }

    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) =>
        Task.Delay(delay, cancellationToken);
}

public interface IRealtimeRetryPolicy
{
    TimeSpan GetDelay(int attempt, RealtimeTransportClose? close);
}

public interface IRealtimeRandom
{
    double NextDouble();
}

public sealed class SystemRealtimeRandom : IRealtimeRandom
{
    private static readonly Random Random = new();
    private static readonly object Sync = new();

    public static SystemRealtimeRandom Instance { get; } = new();

    private SystemRealtimeRandom()
    {
    }

    public double NextDouble()
    {
        lock (Sync)
        {
            return Random.NextDouble();
        }
    }
}

public interface IRealtimeAuthenticationProvider
{
    Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken);
}

public sealed class AnonymousRealtimeAuthenticationProvider : IRealtimeAuthenticationProvider
{
    public static AnonymousRealtimeAuthenticationProvider Instance { get; } = new();

    private AnonymousRealtimeAuthenticationProvider()
    {
    }

    public Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken) =>
        Task.FromResult(RealtimeAuthenticationMaterial.Anonymous);
}

public sealed class RealtimeAuthenticationMaterial
{
    private static readonly IReadOnlyDictionary<string, string> EmptyHeaders =
        new ReadOnlyDictionary<string, string>(new Dictionary<string, string>());

    public static RealtimeAuthenticationMaterial Anonymous { get; } = new();

    public RealtimeAuthenticationMaterial(
        string? connectionTicket = null,
        string? cookieHeader = null,
        IReadOnlyDictionary<string, string>? headers = null)
    {
        ConnectionTicket = connectionTicket;
        CookieHeader = cookieHeader;
        Headers = headers is null
            ? EmptyHeaders
            : new ReadOnlyDictionary<string, string>(headers.ToDictionary(pair => pair.Key, pair => pair.Value));
    }

    public string? ConnectionTicket { get; }

    public string? CookieHeader { get; }

    public IReadOnlyDictionary<string, string> Headers { get; }

    public override string ToString() => "RealtimeAuthenticationMaterial { [REDACTED] }";
}

public sealed record RealtimeTransportClose(
    int? Code,
    string Reason,
    bool Clean,
    ReconnectAdvice? Reconnect = null);

public sealed record RealtimeTransportReceiveResult(byte[]? Payload, RealtimeTransportClose? Close)
{
    public static RealtimeTransportReceiveResult Message(byte[] payload) => new(payload, null);

    public static RealtimeTransportReceiveResult Closed(
        int? code,
        string reason,
        bool clean,
        ReconnectAdvice? reconnect = null) =>
        new(null, new RealtimeTransportClose(code, reason, clean, reconnect));
}

public interface IRealtimeTransport : IDisposable
{
    Task SendAsync(byte[] payload, CancellationToken cancellationToken);

    Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken);

    Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken);
}

public interface IRealtimeTransportFactory
{
    Task<IRealtimeTransport> ConnectAsync(
        Uri endpoint,
        RealtimeAuthenticationMaterial authentication,
        string subProtocol,
        int maximumFrameBytes,
        int maximumMessageBytes,
        CancellationToken cancellationToken);
}

public sealed class RealtimeClientStateChangedEventArgs(
    RealtimeClientState previous,
    RealtimeClientState current) : EventArgs
{
    public RealtimeClientState Previous { get; } = previous;

    public RealtimeClientState Current { get; } = current;
}

public class RealtimeClientException : Exception
{
    public RealtimeClientException(string message)
        : base(message)
    {
    }

}

public sealed class RealtimeProtocolException : RealtimeClientException
{
    public RealtimeProtocolException(string message)
        : base(message)
    {
    }
}
