using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Cormier.Realtime.Client;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.Client.Tests;

public sealed class RealtimeClientTests
{
    [Fact]
    public void ClientAssemblyTargetsNetStandardWithoutAspNetCoreReferences()
    {
        var assembly = typeof(RealtimeClient).Assembly;
        var target = assembly.GetCustomAttributesData().Single(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.Versioning.TargetFrameworkAttribute");

        Assert.Equal(".NETStandard,Version=v2.0", target.ConstructorArguments[0].Value);
        Assert.DoesNotContain(assembly.GetReferencedAssemblies(), reference =>
            reference.Name?.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void AuthenticationMaterialNeverFormatsSecrets()
    {
        var material = new RealtimeAuthenticationMaterial(
            "ticket-secret-value",
            "session=secret-cookie-value",
            new Dictionary<string, string> { ["Authorization"] = "Bearer secret-token-value" });

        var rendered = material.ToString();

        Assert.Equal("RealtimeAuthenticationMaterial { [REDACTED] }", rendered);
        Assert.DoesNotContain("secret", rendered, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("https://gateway.example/realtime/ws")]
    [InlineData("relative/path")]
    public void OptionsRejectNonWebSocketEndpoints(string endpoint)
    {
        var options = Options();
        options.Endpoint = new Uri(endpoint, UriKind.RelativeOrAbsolute);

        Assert.Throws<ArgumentException>(() => new RealtimeClient(options));
    }

    [Fact]
    public async Task PublishAndReceiveUseSharedProtocolContracts()
    {
        var transport = new FakeTransport();
        var factory = new FakeTransportFactory(transport);
        using var client = new RealtimeClient(Options(), transportFactory: factory);
        await client.ConnectAsync(CancellationToken.None);
        var payload = JsonSerializer.SerializeToElement(new { value = 42 });

        await client.PublishAsync("topics/orders", payload, "publish-1", CancellationToken.None);
        var sent = await transport.WaitForSentAsync();
        var command = JsonSerializer.Deserialize(sent, RealtimeJsonSerializerContext.Default.MessageEnvelope);
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Acknowledge,
            "publish-1",
            "topics/orders"));
        var response = await client.ReceiveAsync(CancellationToken.None);

        Assert.Equal(ProtocolMessageTypes.Publish, command?.Type);
        Assert.Equal("topics/orders", command?.Route);
        Assert.Equal(42, command?.Payload.GetProperty("value").GetInt32());
        Assert.Equal(ProtocolMessageTypes.Acknowledge, response.Type);
    }

    [Fact]
    public async Task ConsumerDiagnosticsCannotInterruptTheConnectionLifecycle()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            logger: new ThrowingLogger());
        client.StateChanged += (_, _) => throw new InvalidOperationException("consumer handler failed");

        await client.ConnectAsync(CancellationToken.None);

        Assert.Equal(RealtimeClientState.Connected, client.State);
    }

    [Fact]
    public async Task ReconnectRefreshesAuthenticationAndRestoresEachSubscriptionOnce()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        var authentication = new CountingAuthenticationProvider();
        var clock = new ImmediateClock();
        using var client = new RealtimeClient(
            Options(),
            authentication,
            factory,
            clock: clock,
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "subscribe-1", CancellationToken.None);
        var originalSubscribe = await first.WaitForSentAsync();
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.ServiceRestart,
            "restart",
            clean: true));

        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        var replay = await second.WaitForSentAsync();
        var replayEnvelope = JsonSerializer.Deserialize(replay, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Contains("subscribe", Encoding.UTF8.GetString(originalSubscribe), StringComparison.Ordinal);
        Assert.Equal(ProtocolMessageTypes.Subscribe, replayEnvelope?.Type);
        Assert.Equal("topics/orders", replayEnvelope?.Route);
        Assert.Equal(2, authentication.CallCount);
        Assert.Equal(1, second.SentCount);
    }

    [Fact]
    public async Task ServiceRestartUsesTheServersBoundedReconnectAdvice()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        var clock = new AdviceRecordingClock();
        var options = Options();
        using var client = new RealtimeClient(
            options,
            transportFactory: factory,
            clock: clock,
            retryPolicy: new ExponentialRealtimeRetryPolicy(options, new FixedRandom(0.5)));
        await client.ConnectAsync(CancellationToken.None);
        var restart = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.ServiceRestart,
            "restart-1",
            DateTimeOffset.UtcNow,
            "system/restart",
            Reconnect: new ReconnectAdvice(500, 5_000, 0.2, true));

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            JsonSerializer.SerializeToUtf8Bytes(
                restart,
                RealtimeJsonSerializerContext.Default.ServerMessageEnvelope)));

        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);

        Assert.Equal(TimeSpan.FromMilliseconds(500), clock.ReconnectDelay);
    }

    [Theory]
    [InlineData(0.0, 400)]
    [InlineData(0.5, 500)]
    [InlineData(1.0, 600)]
    public void ServerReconnectJitterUsesTheInjectedRandomSource(double sample, int expectedMilliseconds)
    {
        var policy = new ExponentialRealtimeRetryPolicy(Options(), new FixedRandom(sample));
        var close = new RealtimeTransportClose(
            RealtimeCloseCodes.ServiceRestart,
            "service_restart",
            true,
            new ReconnectAdvice(500, 5_000, 0.2, true));

        var delay = policy.GetDelay(1, close);

        Assert.Equal(TimeSpan.FromMilliseconds(expectedMilliseconds), delay);
    }

    [Fact]
    public async Task SuccessfulReconnectResetsTheConsecutiveAttemptLimit()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var third = new FakeTransport();
        var factory = new FakeTransportFactory(first, second, third);
        using var client = new RealtimeClient(
            Options(maximumReconnectAttempts: 1),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        await second.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 3 && client.State == RealtimeClientState.Connected);

        Assert.Equal(3, factory.ConnectionCount);
    }

    [Fact]
    public async Task NormalRemoteCloseStopsWithoutReconnect()
    {
        var transport = new FakeTransport();
        var factory = new FakeTransportFactory(transport);
        using var client = new RealtimeClient(Options(), transportFactory: factory);
        await client.ConnectAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.Normal,
            "normal",
            clean: true));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Disconnected);

        Assert.Equal(1, factory.ConnectionCount);
    }

    [Fact]
    public async Task DisconnectCancelsAnActiveReconnectDelayAndCompletesChannels()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var options = Options();
        options.InitialReconnectDelayMilliseconds = 30_000;
        options.MaximumReconnectDelayMilliseconds = 30_000;
        using var client = new RealtimeClient(
            options,
            transportFactory: new FakeTransportFactory(first, second));
        await client.ConnectAsync(CancellationToken.None);
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Reconnecting);

        await client.DisconnectAsync(CancellationToken.None);

        Assert.Equal(RealtimeClientState.Disconnected, client.State);
        await Assert.ThrowsAsync<ChannelClosedException>(() => client.ReceiveAsync(CancellationToken.None));
    }

    [Fact]
    public async Task CompletedClientCannotReportAFalseSuccessfulRestart()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await client.DisconnectAsync(CancellationToken.None);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.Contains("cannot be restarted", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task QueuedPublishReceivesAFreshTimestampWhenConnectionStarts()
    {
        var clock = new AdjustableClock(new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero));
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "queued-1",
            CancellationToken.None);
        clock.UtcNow = clock.UtcNow.AddMinutes(10);

        await client.ConnectAsync(CancellationToken.None);
        var sent = await transport.WaitForSentAsync();
        var envelope = JsonSerializer.Deserialize(sent, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal(clock.UtcNow, envelope?.Timestamp);
    }

    [Fact]
    public async Task SendQueueAppliesCancellationBackpressureWhenTransportIsSlow()
    {
        var transport = new FakeTransport { BlockSends = true };
        using var client = new RealtimeClient(Options(sendQueueCapacity: 1), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        var payload = JsonSerializer.SerializeToElement(new { value = 1 });

        await client.PublishAsync("topics/orders", payload, "one", CancellationToken.None);
        await transport.SendStarted.Task;
        await client.PublishAsync("topics/orders", payload, "two", CancellationToken.None);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.PublishAsync("topics/orders", payload, "three", timeout.Token));
        transport.ReleaseSends.TrySetResult(true);
    }

    [Fact]
    public async Task InitialConnectionCancellationStopsTheLifecycle()
    {
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new BlockingTransportFactory());
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.ConnectAsync(cancellation.Token));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Disconnected);

        Assert.Equal(RealtimeClientState.Disconnected, client.State);
    }

    [Fact]
    public async Task OutboundMessagesCannotExceedGatewayFrameLimit()
    {
        var transport = new FakeTransport();
        var options = Options();
        options.MaximumFrameBytes = 1024;
        using var client = new RealtimeClient(options, transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        var payload = JsonSerializer.SerializeToElement(new { value = new string('x', 2_000) });

        await Assert.ThrowsAsync<RealtimeProtocolException>(() =>
            client.PublishAsync("topics/orders", payload, "oversized", CancellationToken.None));

        Assert.Equal(0, transport.SentCount);
    }

    [Fact]
    public async Task RetryFailureDoesNotExposeTicketCookieHeaderOrTransportException()
    {
        const string secret = "ticket-secret-value";
        var authentication = new StaticAuthenticationProvider(new RealtimeAuthenticationMaterial(
            secret,
            "session=cookie-secret-value",
            new Dictionary<string, string> { ["Authorization"] = "Bearer header-secret-value" }));
        var factory = new ThrowingTransportFactory(secret);
        using var client = new RealtimeClient(
            Options(maximumReconnectAttempts: 1),
            authentication,
            factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());

        var exception = await Assert.ThrowsAsync<RealtimeClientException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.DoesNotContain("secret", exception.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, factory.ConnectionCount);
    }

    [Fact]
    public async Task InvalidServerEnvelopeFaultsWithoutEnteringReceiveQueue()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            Encoding.UTF8.GetBytes("{\"version\":\"99\",\"type\":\"event\"}")));

        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);

        Assert.Equal(RealtimeClientState.Faulted, client.State);
    }

    private static RealtimeClientOptions Options(
        int sendQueueCapacity = 8,
        int maximumReconnectAttempts = 3) => new()
        {
            Endpoint = new Uri("wss://gateway.example/realtime/ws"),
            SendQueueCapacity = sendQueueCapacity,
            ReceiveQueueCapacity = 8,
            HeartbeatSeconds = 300,
            MaximumReconnectAttempts = maximumReconnectAttempts,
            InitialReconnectDelayMilliseconds = 0,
            MaximumReconnectDelayMilliseconds = 0,
        };

    private static RealtimeTransportReceiveResult Server(string type, string correlationId, string route)
    {
        var envelope = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            type,
            correlationId,
            DateTimeOffset.UtcNow,
            route,
            JsonSerializer.SerializeToElement(new { ok = true }));
        return RealtimeTransportReceiveResult.Message(JsonSerializer.SerializeToUtf8Bytes(
            envelope,
            RealtimeJsonSerializerContext.Default.ServerMessageEnvelope));
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class FakeTransportFactory(params FakeTransport[] transports) : IRealtimeTransportFactory
    {
        private int _index;

        public int ConnectionCount => Volatile.Read(ref _index);

        public Task<IRealtimeTransport> ConnectAsync(
            Uri endpoint,
            RealtimeAuthenticationMaterial authentication,
            string subProtocol,
            int maximumFrameBytes,
            int maximumMessageBytes,
            CancellationToken cancellationToken)
        {
            var index = Interlocked.Increment(ref _index) - 1;
            if (index >= transports.Length)
            {
                throw new InvalidOperationException("No fake transport is available.");
            }
            return Task.FromResult<IRealtimeTransport>(transports[index]);
        }
    }

    private sealed class AdviceRecordingClock : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public TimeSpan? ReconnectDelay { get; private set; }

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            if (delay >= TimeSpan.FromSeconds(300))
            {
                return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            ReconnectDelay = delay;
            return Task.CompletedTask;
        }
    }

    private sealed class AdjustableClock(DateTimeOffset now) : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) =>
            Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
    }

    private sealed class ThrowingTransportFactory(string secret) : IRealtimeTransportFactory
    {
        private int _connectionCount;

        public int ConnectionCount => Volatile.Read(ref _connectionCount);

        public Task<IRealtimeTransport> ConnectAsync(
            Uri endpoint,
            RealtimeAuthenticationMaterial authentication,
            string subProtocol,
            int maximumFrameBytes,
            int maximumMessageBytes,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _connectionCount);
            throw new InvalidOperationException($"Transport failed with {secret} and {authentication.CookieHeader}.");
        }
    }

    private sealed class BlockingTransportFactory : IRealtimeTransportFactory
    {
        public async Task<IRealtimeTransport> ConnectAsync(
            Uri endpoint,
            RealtimeAuthenticationMaterial authentication,
            string subProtocol,
            int maximumFrameBytes,
            int maximumMessageBytes,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("The connection wait unexpectedly completed.");
        }
    }

    private sealed class FakeTransport : IRealtimeTransport
    {
        private readonly Channel<byte[]> _sent = Channel.CreateUnbounded<byte[]>();
        private readonly Channel<RealtimeTransportReceiveResult> _received =
            Channel.CreateUnbounded<RealtimeTransportReceiveResult>();
        private int _sentCount;

        public ChannelWriter<RealtimeTransportReceiveResult> ReceiveWriter => _received.Writer;

        public bool BlockSends { get; set; }

        public TaskCompletionSource<bool> SendStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> ReleaseSends { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int SentCount => Volatile.Read(ref _sentCount);

        public async Task SendAsync(byte[] payload, CancellationToken cancellationToken)
        {
            SendStarted.TrySetResult(true);
            if (BlockSends)
            {
                await ReleaseSends.Task.WaitAsync(cancellationToken);
            }
            Interlocked.Increment(ref _sentCount);
            await _sent.Writer.WriteAsync(payload, cancellationToken);
        }

        public async Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken) =>
            await _received.Reader.ReadAsync(cancellationToken);

        public Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken) => Task.CompletedTask;

        public async Task<byte[]> WaitForSentAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            return await _sent.Reader.ReadAsync(timeout.Token);
        }

        public void Dispose()
        {
            _sent.Writer.TryComplete();
            _received.Writer.TryComplete();
        }
    }

    private sealed class CountingAuthenticationProvider : IRealtimeAuthenticationProvider
    {
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);

        public Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _callCount);
            return Task.FromResult(new RealtimeAuthenticationMaterial($"ticket-{call}"));
        }
    }

    private sealed class StaticAuthenticationProvider(RealtimeAuthenticationMaterial material) : IRealtimeAuthenticationProvider
    {
        public Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken) =>
            Task.FromResult(material);
    }

    private sealed class ImmediateClock : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) =>
            delay == TimeSpan.Zero
                ? Task.CompletedTask
                : Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
    }

    private sealed class FixedRetryPolicy : IRealtimeRetryPolicy
    {
        public TimeSpan GetDelay(int attempt, RealtimeTransportClose? close) => TimeSpan.Zero;
    }

    private sealed class FixedRandom(double value) : IRealtimeRandom
    {
        public double NextDouble() => value;
    }

    private sealed class ThrowingLogger : IRealtimeClientLogger
    {
        public void Log(RealtimeClientLogLevel level, int eventId, string message) =>
            throw new InvalidOperationException("consumer logger failed");
    }
}
