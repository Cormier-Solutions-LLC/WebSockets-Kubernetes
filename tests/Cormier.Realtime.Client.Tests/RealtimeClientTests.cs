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

    [Theory]
    [InlineData("invalid protocol")]
    [InlineData("invalid,protocol")]
    [InlineData("invalid/protocol")]
    [InlineData("π")]
    public void OptionsRejectInvalidWebSocketSubprotocolTokens(string subProtocol)
    {
        var options = Options();
        options.SubProtocol = subProtocol;

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

    [Theory]
    [InlineData(0.0, 800)]
    [InlineData(0.5, 1_000)]
    [InlineData(1.0, 1_200)]
    public void OrdinaryReconnectsUseConfiguredJitter(double sample, int expectedMilliseconds)
    {
        var options = Options();
        options.InitialReconnectDelayMilliseconds = 1_000;
        options.MaximumReconnectDelayMilliseconds = 10_000;
        options.ReconnectJitterRatio = 0.2;
        var policy = new ExponentialRealtimeRetryPolicy(options, new FixedRandom(sample));

        Assert.Equal(TimeSpan.FromMilliseconds(expectedMilliseconds), policy.GetDelay(1, null));
    }

    [Fact]
    public void OptionsRejectNaNReconnectJitter()
    {
        var options = Options();
        options.ReconnectJitterRatio = double.NaN;

        Assert.Throws<ArgumentOutOfRangeException>(() => new RealtimeClient(options));
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(2, 1)]
    [InlineData(3, 2)]
    [InlineData(4, 4)]
    public void ZeroInitialReconnectDelayOnlyMakesTheFirstRetryImmediate(int attempt, int expectedMilliseconds)
    {
        var options = Options();
        options.InitialReconnectDelayMilliseconds = 0;
        options.MaximumReconnectDelayMilliseconds = 100;
        var policy = new ExponentialRealtimeRetryPolicy(options, new FixedRandom(0.5));

        Assert.Equal(TimeSpan.FromMilliseconds(expectedMilliseconds), policy.GetDelay(attempt, null));
    }

    [Fact]
    public async Task ProtocolFailuresUseTheirWireCloseCode()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);

        transport.FailReceive(new RealtimeProtocolException(
            "Expected oversized frame.",
            RealtimeCloseCodes.MessageTooLarge));
        await transport.CloseStarted.Task;

        Assert.Equal(RealtimeCloseCodes.MessageTooLarge, transport.LastCloseCode);
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
    public async Task NormalRemoteCloseStopsAcceptingSendsBeforeTransportCleanup()
    {
        var transport = new FakeTransport { BlockClose = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.Normal,
            "normal",
            clean: true));
        await transport.CloseStarted.Task;

        await Assert.ThrowsAsync<ChannelClosedException>(() => client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "after-remote-close"));
        transport.ReleaseClose.TrySetResult(true);
        await WaitUntilAsync(() => client.State == RealtimeClientState.Disconnected);
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
    public async Task ConnectAsyncRejectsAnActiveReconnect()
    {
        var transport = new FakeTransport { BlockClose = true };
        var clock = new BlockingReconnectClock();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock,
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await transport.CloseStarted.Task;

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.Contains("reconnecting or stopping", exception.Message, StringComparison.Ordinal);
        transport.ReleaseClose.TrySetResult(true);
        await client.DisconnectAsync(CancellationToken.None);
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
    public async Task ActiveSendQueueRefreshesTimestampsImmediatelyBeforeDelivery()
    {
        var clock = new AdjustableClock(new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero));
        var transport = new FakeTransport { BlockSends = true };
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock);
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked");
        await transport.SendStarted.Task;
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 2 }),
            "queued");
        clock.UtcNow = clock.UtcNow.AddMinutes(10);

        transport.ReleaseSends.TrySetResult(true);
        _ = await transport.WaitForSentAsync();
        var queued = JsonSerializer.Deserialize(
            await transport.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal("queued", queued?.CorrelationId);
        Assert.Equal(clock.UtcNow, queued?.Timestamp);
    }

    [Fact]
    public async Task QueuedPublishOwnsItsJsonPayload()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        using (var document = JsonDocument.Parse("{\"value\":42}"))
        {
            await client.PublishAsync("topics/orders", document.RootElement, "owned-payload", CancellationToken.None);
        }

        await client.ConnectAsync(CancellationToken.None);
        var sent = await transport.WaitForSentAsync();
        var envelope = JsonSerializer.Deserialize(sent, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal(42, envelope?.Payload.GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task ReplayRefreshesEachMessageImmediatelyBeforeItsSend()
    {
        var transport = new FakeTransport { BlockSends = true };
        var clock = new AdjustableClock(new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero));
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock);
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 1 }), "one");
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 2 }), "two");

        var connecting = client.ConnectAsync(CancellationToken.None);
        await transport.SendStarted.Task;
        clock.UtcNow = clock.UtcNow.AddMinutes(10);
        transport.ReleaseSends.TrySetResult(true);
        await connecting;
        var first = JsonSerializer.Deserialize(
            await transport.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        var second = JsonSerializer.Deserialize(
            await transport.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal(new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero), first?.Timestamp);
        Assert.Equal(clock.UtcNow, second?.Timestamp);
    }

    [Fact]
    public async Task FailedReplayRetainsUnsentPublishesForTheNextConnection()
    {
        var first = new FakeTransport { FailOnSendNumber = 2 };
        var second = new FakeTransport();
        var clock = new AdvancingReconnectClock(
            new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero),
            TimeSpan.FromMinutes(10));
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(first, second),
            clock: clock,
            retryPolicy: new FixedRetryPolicy());
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 1 }), "one");
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 2 }), "two");

        await client.ConnectAsync(CancellationToken.None);
        var replayed = await second.WaitForSentAsync();
        var envelope = JsonSerializer.Deserialize(replayed, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal("two", envelope?.CorrelationId);
        Assert.Equal(clock.UtcNow, envelope?.Timestamp);
    }

    [Fact]
    public async Task ActiveSendFailureCancelsSiblingLoopsAndReplaysThePublish()
    {
        var first = new FakeTransport { BlockSends = true };
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "in-flight");
        await first.SendStarted.Task;

        first.FailReceive();
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        var replayed = await second.WaitForSentAsync();
        var envelope = JsonSerializer.Deserialize(replayed, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal("in-flight", envelope?.CorrelationId);
    }

    [Fact]
    public async Task NormalCloseWinsWhenAnActiveSendFaultsAtTheSameTime()
    {
        var transport = new CloseThenFailSendTransport();
        var factory = new FakeTransportFactory(transport, new FakeTransport());
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);

        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "closing-send");
        await WaitUntilAsync(() => client.State == RealtimeClientState.Disconnected);

        Assert.Equal(1, factory.ConnectionCount);
        await Assert.ThrowsAsync<ChannelClosedException>(() => client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 2 }),
            "after-close"));
    }

    [Fact]
    public async Task CloseObservedDuringInitialReplayPreventsSuccessfulConnect()
    {
        var transport = new CloseDuringReplayTransport();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new YieldingTransportFactory(transport));
        transport.StateProvider = () => client.State;
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "queued-before-connect");

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.Equal(RealtimeClientState.Disconnected, client.State);
    }

    [Fact]
    public async Task LowLevelMessagesQueuedBeforeConnectAreRetained()
    {
        var transport = new FakeTransport();
        var clock = new AdjustableClock(new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero));
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock);
        await client.SendAsync(new MessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Ping,
            "queued-ping",
            clock.UtcNow,
            "system/heartbeat",
            default));

        await client.ConnectAsync(CancellationToken.None);
        var sent = await transport.WaitForSentAsync();
        var envelope = JsonSerializer.Deserialize(sent, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.Equal(ProtocolMessageTypes.Ping, envelope?.Type);
        Assert.Equal("queued-ping", envelope?.CorrelationId);
        Assert.Equal(JsonValueKind.Null, envelope?.Payload.ValueKind);
    }

    [Fact]
    public void LowLevelSubscriptionCommandsRequireTheStatefulApi()
    {
        using var client = new RealtimeClient(Options());
        var message = new MessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Subscribe,
            "low-level-subscribe",
            DateTimeOffset.UtcNow,
            "topics/orders",
            default);

        var exception = Assert.Throws<InvalidOperationException>(() =>
        {
            _ = client.SendAsync(message);
        });

        Assert.Contains("SubscribeAsync", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DisconnectedSubscriptionChangeDoesNotWaitForQueueCapacity()
    {
        using var client = new RealtimeClient(Options(sendQueueCapacity: 1));
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "queued-publish");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.SubscribeAsync(
            "topics/orders",
            "invalid-subscribe",
            cancellation.Token));
    }

    [Fact]
    public async Task ReplayBacklogSharesTheConfiguredSendCapacity()
    {
        var first = new FakeTransport { FailOnSendNumber = 1 };
        var clock = new BlockingReconnectClock();
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 2),
            transportFactory: new FakeTransportFactory(first),
            clock: clock,
            retryPolicy: new FixedRetryPolicy());
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 1 }), "one");
        await client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 2 }), "two");
        var connecting = client.ConnectAsync(CancellationToken.None);
        await clock.DelayStarted.Task;
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.PublishAsync("topics/orders", JsonSerializer.SerializeToElement(new { value = 3 }), "three", timeout.Token));
        await client.DisconnectAsync(CancellationToken.None);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => connecting);
    }

    [Fact]
    public async Task DisconnectBeforeConnectCompletesPendingReceivers()
    {
        using var client = new RealtimeClient(Options());
        var receive = client.ReceiveAsync(CancellationToken.None);

        await client.DisconnectAsync(CancellationToken.None);

        await Assert.ThrowsAsync<ChannelClosedException>(() => receive);
        Assert.Equal(RealtimeClientState.Disconnected, client.State);
    }

    [Fact]
    public async Task TerminalCleanupDiscardsBufferedInboundPayloads()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Event,
            "buffered-event",
            "topics/orders"));
        await WaitUntilAsync(() => transport.ReceiveCount >= 2);

        await client.DisconnectAsync(CancellationToken.None);

        await Assert.ThrowsAsync<ChannelClosedException>(() => client.ReceiveAsync(CancellationToken.None));
    }

    [Fact]
    public async Task SendsAreRejectedAfterDisconnectStarts()
    {
        var transport = new FakeTransport { BlockClose = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);

        var disconnect = client.DisconnectAsync(CancellationToken.None);
        await transport.CloseStarted.Task;

        await Assert.ThrowsAsync<ChannelClosedException>(() => client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "during-stop"));
        transport.ReleaseClose.TrySetResult(true);
        await disconnect;
    }

    [Fact]
    public async Task DisconnectAfterFaultPreservesTheTerminalState()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            Encoding.UTF8.GetBytes("{\"version\":\"99\",\"type\":\"event\"}")));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);

        await client.DisconnectAsync(CancellationToken.None);

        Assert.Equal(RealtimeClientState.Faulted, client.State);
    }

    [Fact]
    public async Task DisconnectAfterFaultAwaitsTerminalCleanup()
    {
        var transport = new FakeTransport { BlockClose = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            Encoding.UTF8.GetBytes("{\"version\":\"99\",\"type\":\"event\"}")));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);
        await transport.CloseStarted.Task;

        var disconnect = client.DisconnectAsync(CancellationToken.None);

        Assert.False(disconnect.IsCompleted);
        transport.ReleaseClose.TrySetResult(true);
        await disconnect;
        await Assert.ThrowsAsync<ChannelClosedException>(() => client.ReceiveAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ThrowingTransportDisposeStillCompletesTerminalCleanup()
    {
        var transport = new FakeTransport { ThrowOnDispose = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        var receive = client.ReceiveAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.Normal,
            "normal_close",
            clean: true));

        await Assert.ThrowsAsync<ChannelClosedException>(() => receive);
        Assert.Equal(RealtimeClientState.Disconnected, client.State);
    }

    [Fact]
    public async Task ProtocolFailureStopsSendAdmissionBeforeSiblingShutdown()
    {
        var transport = new FakeTransport { BlockSends = true, IgnoreSendCancellation = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked-send");
        await transport.SendStarted.Task;

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            Encoding.UTF8.GetBytes("{\"version\":\"99\",\"type\":\"event\"}")));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);
        try
        {
            await Assert.ThrowsAsync<ChannelClosedException>(() => client.PublishAsync(
                "topics/orders",
                JsonSerializer.SerializeToElement(new { value = 2 }),
                "after-protocol-failure"));
        }
        finally
        {
            transport.ReleaseSends.TrySetResult(true);
        }
    }

    [Fact]
    public async Task TransportProtocolFailureStopsSendAdmissionBeforeSiblingShutdown()
    {
        var transport = new FakeTransport { BlockSends = true, IgnoreSendCancellation = true };
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked-send");
        await transport.SendStarted.Task;

        transport.FailReceive(new RealtimeProtocolException(
            "The transport rejected the frame.",
            RealtimeCloseCodes.InvalidPayloadData));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);
        try
        {
            await Assert.ThrowsAsync<ChannelClosedException>(() => client.PublishAsync(
                "topics/orders",
                JsonSerializer.SerializeToElement(new { value = 2 }),
                "after-transport-protocol-failure"));
        }
        finally
        {
            transport.ReleaseSends.TrySetResult(true);
        }
    }

    [Fact]
    public async Task InitialTransportProtocolFailurePreservesItsCloseCode()
    {
        var transport = new FakeTransport();
        transport.FailReceive(new RealtimeProtocolException(
            "The transport rejected an oversized frame.",
            RealtimeCloseCodes.MessageTooLarge));
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new YieldingTransportFactory(transport));

        var exception = await Assert.ThrowsAsync<RealtimeProtocolException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.Equal(RealtimeCloseCodes.MessageTooLarge, exception.CloseCode);
    }

    [Fact]
    public async Task CredentialedNonLoopbackPlaintextEndpointIsRejected()
    {
        var options = Options();
        options.Endpoint = new Uri("ws://gateway.example/realtime/ws");
        var factory = new FakeTransportFactory(new FakeTransport());
        using var client = new RealtimeClient(
            options,
            new StaticAuthenticationProvider(new RealtimeAuthenticationMaterial("sensitive-ticket")),
            factory);

        var exception = await Assert.ThrowsAsync<RealtimeClientException>(() =>
            client.ConnectAsync(CancellationToken.None));

        Assert.Contains("require wss", exception.Message, StringComparison.Ordinal);
        Assert.Equal(0, factory.ConnectionCount);
    }

    [Theory]
    [InlineData("ws://gateway.example/realtime/ws?ticket=sensitive-ticket")]
    [InlineData("wss://gateway.example/realtime/ws?TICKET=sensitive-ticket")]
    public void EndpointTicketQueryIsRejected(string endpoint)
    {
        var options = Options();
        options.Endpoint = new Uri(endpoint);

        Assert.Throws<ArgumentException>(() => new RealtimeClient(options));
    }

    [Fact]
    public async Task PlaintextCredentialTransportRequiresExplicitOptIn()
    {
        var options = Options();
        options.Endpoint = new Uri("ws://gateway.example/realtime/ws");
        options.AllowInsecureCredentialTransport = true;
        var factory = new FakeTransportFactory(new FakeTransport());
        using var client = new RealtimeClient(
            options,
            new StaticAuthenticationProvider(new RealtimeAuthenticationMaterial("test-ticket")),
            factory);

        await client.ConnectAsync(CancellationToken.None);

        Assert.Equal(RealtimeClientState.Connected, client.State);
        Assert.Equal(1, factory.ConnectionCount);
    }

    [Fact]
    public async Task StateNotificationsPreserveTransitionOrderDuringDisconnect()
    {
        var observed = new ConcurrentQueue<RealtimeClientState>();
        var disconnected = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(new FakeTransport()));
        client.StateChanged += (_, change) =>
        {
            observed.Enqueue(change.Current);
            if (change.Current == RealtimeClientState.Disconnected)
            {
                disconnected.TrySetResult(true);
            }
        };
        await client.ConnectAsync(CancellationToken.None);

        await client.DisconnectAsync(CancellationToken.None);
        await disconnected.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(
            new[]
            {
                RealtimeClientState.Connecting,
                RealtimeClientState.Connected,
                RealtimeClientState.Stopping,
                RealtimeClientState.Disconnected,
            },
            observed);
    }

    [Fact]
    public async Task ConcurrentSubscriptionChangesAreSentInDesiredStateOrder()
    {
        var transport = new FakeTransport { BlockSends = true };
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 2),
            transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        var payload = JsonSerializer.SerializeToElement(new { value = 1 });
        await client.PublishAsync("topics/orders", payload, "blocker");
        await transport.SendStarted.Task;
        await client.PublishAsync("topics/orders", payload, "queued");

        var subscribe = client.SubscribeAsync("topics/orders", "subscribe");
        await Task.Delay(25);
        var unsubscribe = client.UnsubscribeAsync("topics/orders", "unsubscribe");
        transport.ReleaseSends.TrySetResult(true);
        await Task.WhenAll(subscribe, unsubscribe);

        var sent = new List<MessageEnvelope>();
        for (var index = 0; index < 4; index++)
        {
            sent.Add(JsonSerializer.Deserialize(
                await transport.WaitForSentAsync(),
                RealtimeJsonSerializerContext.Default.MessageEnvelope)!);
        }
        Assert.Equal(
            new[] { ProtocolMessageTypes.Subscribe, ProtocolMessageTypes.Unsubscribe },
            sent.Where(message => message.Type is ProtocolMessageTypes.Subscribe or ProtocolMessageTypes.Unsubscribe)
                .Select(message => message.Type));
    }

    [Fact]
    public async Task ReconnectCoalescesQueuedSubscriptionCommandsToDesiredState()
    {
        var first = new FakeTransport { BlockSends = true };
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked-publish");
        await first.SendStarted.Task;
        await client.SubscribeAsync("topics/orders", "queued-subscribe");

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        var replayed = new[]
        {
            JsonSerializer.Deserialize(
                await second.WaitForSentAsync(),
                RealtimeJsonSerializerContext.Default.MessageEnvelope)!,
            JsonSerializer.Deserialize(
                await second.WaitForSentAsync(),
                RealtimeJsonSerializerContext.Default.MessageEnvelope)!,
        };

        Assert.Single(replayed, message => message.Type == ProtocolMessageTypes.Subscribe);
        Assert.Single(replayed, message => message.Type == ProtocolMessageTypes.Publish);
        Assert.Equal(2, second.SentCount);
    }

    [Fact]
    public async Task FailedSubscriptionReplayRetainsPendingApplicationMessages()
    {
        var first = new FakeTransport();
        var second = new FakeTransport { FailOnSendNumber = 1 };
        var third = new FakeTransport();
        var factory = new FakeTransportFactory(first, second, third);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "initial-subscribe");
        _ = await first.WaitForSentAsync();
        first.BlockSends = true;
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "pending-publish");
        await first.SendStarted.Task;

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 3 && client.State == RealtimeClientState.Connected);
        var replayed = new[]
        {
            JsonSerializer.Deserialize(
                await third.WaitForSentAsync(),
                RealtimeJsonSerializerContext.Default.MessageEnvelope)!,
            JsonSerializer.Deserialize(
                await third.WaitForSentAsync(),
                RealtimeJsonSerializerContext.Default.MessageEnvelope)!,
        };

        Assert.Single(replayed, message => message.Type == ProtocolMessageTypes.Subscribe);
        Assert.Single(replayed, message => message.CorrelationId == "pending-publish");
    }

    [Fact]
    public async Task ReceiveLoopRunsWhileInitialBacklogIsReplayed()
    {
        var transport = new FakeTransport { BlockSends = true };
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport));
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "queued-publish");

        var connecting = client.ConnectAsync(CancellationToken.None);
        await transport.SendStarted.Task;
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Event,
            "event-during-replay",
            "topics/orders"));

        var received = await client.ReceiveAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal("event-during-replay", received.CorrelationId);
        transport.ReleaseSends.TrySetResult(true);
        await connecting;
    }

    [Fact]
    public async Task RejectedSubscriptionIsRemovedFromDesiredReconnectState()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "rejected-subscribe");
        _ = await first.WaitForSentAsync();
        var rejection = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Error,
            "rejected-subscribe",
            DateTimeOffset.UtcNow,
            "topics/orders",
            Error: new ProtocolError(ProtocolErrorCodes.Unauthorized, "The route is unauthorized."));
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            JsonSerializer.SerializeToUtf8Bytes(
                rejection,
                RealtimeJsonSerializerContext.Default.ServerMessageEnvelope)));
        _ = await client.ReceiveAsync(CancellationToken.None);

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);

        Assert.Equal(0, second.SentCount);
    }

    [Fact]
    public async Task RejectedAlternatingSubscriptionCommandsPreserveTheLatestIntent()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "subscribe");
        _ = await first.WaitForSentAsync();
        await client.UnsubscribeAsync("topics/orders", "unsubscribe");
        _ = await first.WaitForSentAsync();

        await first.ReceiveWriter.WriteAsync(ServerError("subscribe", "topics/orders"));
        await first.ReceiveWriter.WriteAsync(ServerError("unsubscribe", "topics/orders"));
        _ = await client.ReceiveAsync(CancellationToken.None);
        _ = await client.ReceiveAsync(CancellationToken.None);
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);

        Assert.Equal(0, second.SentCount);
    }

    [Fact]
    public async Task PendingSubscriptionResponsesAreBoundedBySendQueueCapacity()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 1),
            transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "subscribe");
        _ = await transport.WaitForSentAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.UnsubscribeAsync("topics/orders", "blocked-unsubscribe", timeout.Token));

        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Acknowledge,
            "subscribe",
            "topics/orders"));
        _ = await client.ReceiveAsync(CancellationToken.None);
        await client.UnsubscribeAsync("topics/orders", "unblocked-unsubscribe");
        var sent = JsonSerializer.Deserialize(
            await transport.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        Assert.Equal("unblocked-unsubscribe", sent?.CorrelationId);
    }

    [Fact]
    public async Task SubscriptionWaitingForResponseCapacityRechecksAfterReconnectStarts()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 1),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "pending-subscribe");
        _ = await first.WaitForSentAsync();
        var unsubscribe = client.UnsubscribeAsync("topics/orders", "waiting-unsubscribe");
        await Task.Delay(25);

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));

        await Assert.ThrowsAsync<InvalidOperationException>(() => unsubscribe);
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        var replayed = JsonSerializer.Deserialize(
            await second.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        Assert.Equal(ProtocolMessageTypes.Subscribe, replayed?.Type);
    }

    [Fact]
    public async Task WaitingSubscriptionIntentIsReappliedAfterEarlierAcknowledgement()
    {
        var first = new FakeTransport();
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 1),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "subscribe");
        _ = await first.WaitForSentAsync();
        var unsubscribe = client.UnsubscribeAsync("topics/orders", "unsubscribe");
        await Task.Delay(25);

        await first.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Acknowledge,
            "subscribe",
            "topics/orders"));
        _ = await client.ReceiveAsync(CancellationToken.None);
        await unsubscribe;
        _ = await first.WaitForSentAsync();
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);

        Assert.Equal(0, second.SentCount);
    }

    [Fact]
    public async Task NoOpSubscriptionChangeDoesNotWaitForSendCapacity()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 1),
            transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);
        await client.SubscribeAsync("topics/orders", "subscribe");
        _ = await transport.WaitForSentAsync();
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Acknowledge,
            "subscribe",
            "topics/orders"));
        _ = await client.ReceiveAsync(CancellationToken.None);
        transport.BlockSends = true;
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked-publish");
        await transport.SendStarted.Task;

        try
        {
            await client.SubscribeAsync("topics/orders", "no-op")
                .WaitAsync(TimeSpan.FromSeconds(1));
        }
        finally
        {
            transport.ReleaseSends.TrySetResult(true);
        }
    }

    [Fact]
    public async Task MissingHeartbeatAcknowledgementDoesNotStopLaterHeartbeats()
    {
        var transport = new FakeTransport();
        var clock = new TwoHeartbeatClock();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: clock);

        await client.ConnectAsync(CancellationToken.None);
        _ = await transport.WaitForSentAsync();
        await clock.ThirdDelayStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(2, transport.SentCount);
    }

    [Fact]
    public async Task ReconnectDoesNotReplayACancelledPendingSubscriptionMutation()
    {
        var first = new FakeTransport { BlockSends = true, BlockClose = true };
        var second = new FakeTransport();
        var factory = new FakeTransportFactory(first, second);
        using var client = new RealtimeClient(
            Options(sendQueueCapacity: 1),
            transportFactory: factory,
            clock: new ImmediateClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        await client.PublishAsync(
            "topics/orders",
            JsonSerializer.SerializeToElement(new { value = 1 }),
            "blocked-publish");
        await first.SendStarted.Task;
        using var cancellation = new CancellationTokenSource();
        var subscribe = client.SubscribeAsync(
            "topics/orders",
            "cancelled-subscribe",
            cancellation.Token);

        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await first.CloseStarted.Task;
        cancellation.Cancel();
        first.ReleaseClose.TrySetResult(true);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => subscribe);
        await WaitUntilAsync(() => factory.ConnectionCount == 2 && client.State == RealtimeClientState.Connected);
        var replayed = JsonSerializer.Deserialize(
            await second.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        Assert.Equal(ProtocolMessageTypes.Publish, replayed?.Type);
        Assert.Equal(1, second.SentCount);
    }

    [Fact]
    public async Task AutomaticHeartbeatTrafficDoesNotEnterTheApplicationQueue()
    {
        var transport = new FakeTransport();
        var options = Options();
        options.ReceiveQueueCapacity = 1;
        options.HeartbeatSeconds = 5;
        using var client = new RealtimeClient(
            options,
            transportFactory: new FakeTransportFactory(transport),
            clock: new OneHeartbeatClock());
        await client.ConnectAsync(CancellationToken.None);
        var heartbeat = JsonSerializer.Deserialize(
            await transport.WaitForSentAsync(),
            RealtimeJsonSerializerContext.Default.MessageEnvelope)!;

        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Ping,
            "server-heartbeat",
            "system/heartbeat"));
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Acknowledge,
            heartbeat.CorrelationId,
            heartbeat.Route));
        await transport.ReceiveWriter.WriteAsync(Server(
            ProtocolMessageTypes.Event,
            "event-1",
            "topics/orders"));

        var received = await client.ReceiveAsync(CancellationToken.None);

        Assert.Equal(ProtocolMessageTypes.Event, received.Type);
        Assert.Equal("event-1", received.CorrelationId);
    }

    [Fact]
    public void ReconnectAdviceRequiresEveryProtocolField()
    {
        const string malformed = """
            {"version":"1.0","type":"service.restart","correlationId":"restart","timestamp":"2026-09-10T00:00:00Z","route":"system/restart","reconnect":{}}
            """;

        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize(
            malformed,
            RealtimeJsonSerializerContext.Default.ServerMessageEnvelope));
    }

    [Fact]
    public void ReconnectAdviceRejectsDelaysAboveTheSupportedMaximum()
    {
        var envelope = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.ServiceRestart,
            "restart",
            DateTimeOffset.UtcNow,
            "system/restart",
            Reconnect: new ReconnectAdvice(0, int.MaxValue, 0, true));

        var validation = ProtocolValidator.Validate(envelope);

        Assert.False(validation.IsValid);
        Assert.Equal(ProtocolErrorCodes.InvalidEnvelope, validation.ErrorCode);
    }

    [Fact]
    public async Task RestartAdviceSurvivesAFailedReconnectAttempt()
    {
        var first = new FakeTransport();
        var third = new FakeTransport();
        var factory = new FailSecondConnectionFactory(first, third);
        var clock = new RecordingClock();
        var options = Options();
        using var client = new RealtimeClient(
            options,
            transportFactory: factory,
            clock: clock,
            retryPolicy: new ExponentialRealtimeRetryPolicy(options, new FixedRandom(0.5)));
        await client.ConnectAsync(CancellationToken.None);
        await first.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.ServiceRestart,
            "restart",
            clean: true,
            new ReconnectAdvice(500, 5_000, 0, true)));

        await WaitUntilAsync(() => factory.ConnectionCount == 3 && client.State == RealtimeClientState.Connected);

        Assert.Equal(new[] { TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(1_000) }, clock.Delays);
    }

    [Fact]
    public async Task SendQueueAppliesCancellationBackpressureWhenTransportIsSlow()
    {
        var transport = new FakeTransport { BlockSends = true };
        using var client = new RealtimeClient(Options(sendQueueCapacity: 2), transportFactory: new FakeTransportFactory(transport));
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
    public async Task RetryPolicyFailureCompletesTheTerminalLifecycle()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            retryPolicy: new ThrowingRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        var receive = client.ReceiveAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);

        await Assert.ThrowsAsync<ChannelClosedException>(() => receive);
    }

    [Fact]
    public async Task RetryClockFailureCompletesTheTerminalLifecycle()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(
            Options(),
            transportFactory: new FakeTransportFactory(transport),
            clock: new ThrowingReconnectClock(),
            retryPolicy: new FixedRetryPolicy());
        await client.ConnectAsync(CancellationToken.None);
        var receive = client.ReceiveAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Closed(
            RealtimeCloseCodes.GoingAway,
            "network_interruption",
            clean: false));
        await WaitUntilAsync(() => client.State == RealtimeClientState.Faulted);

        await Assert.ThrowsAsync<ChannelClosedException>(() => receive);
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
        await transport.CloseStarted.Task;

        Assert.Equal(RealtimeClientState.Faulted, client.State);
        Assert.Equal(RealtimeCloseCodes.InvalidPayloadData, transport.LastCloseCode);
    }

    [Fact]
    public async Task MalformedServerJsonUsesTheInvalidPayloadCloseCode()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(RealtimeTransportReceiveResult.Message(
            Encoding.UTF8.GetBytes("{")));
        await transport.CloseStarted.Task;

        Assert.Equal(RealtimeCloseCodes.InvalidPayloadData, transport.LastCloseCode);
    }

    [Fact]
    public async Task EmptyServerMessageUsesTheInvalidPayloadCloseCode()
    {
        var transport = new FakeTransport();
        using var client = new RealtimeClient(Options(), transportFactory: new FakeTransportFactory(transport));
        await client.ConnectAsync(CancellationToken.None);

        await transport.ReceiveWriter.WriteAsync(new RealtimeTransportReceiveResult(null, null));
        await transport.CloseStarted.Task;

        Assert.Equal(RealtimeCloseCodes.InvalidPayloadData, transport.LastCloseCode);
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

    private static RealtimeTransportReceiveResult ServerError(string correlationId, string route)
    {
        var envelope = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Error,
            correlationId,
            DateTimeOffset.UtcNow,
            route,
            Error: new ProtocolError(ProtocolErrorCodes.Unauthorized, "The route is unauthorized."));
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

    private sealed class FakeTransportFactory(params IRealtimeTransport[] transports) : IRealtimeTransportFactory
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

    private sealed class YieldingTransportFactory(IRealtimeTransport transport) : IRealtimeTransportFactory
    {
        public async Task<IRealtimeTransport> ConnectAsync(
            Uri endpoint,
            RealtimeAuthenticationMaterial authentication,
            string subProtocol,
            int maximumFrameBytes,
            int maximumMessageBytes,
            CancellationToken cancellationToken)
        {
            await Task.Yield();
            return transport;
        }
    }

    private sealed class FailSecondConnectionFactory(FakeTransport first, FakeTransport third) : IRealtimeTransportFactory
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
            return Interlocked.Increment(ref _connectionCount) switch
            {
                1 => Task.FromResult<IRealtimeTransport>(first),
                2 => throw new InvalidOperationException("Expected reconnect failure."),
                3 => Task.FromResult<IRealtimeTransport>(third),
                _ => throw new InvalidOperationException("No fake transport is available."),
            };
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

    private sealed class CloseThenFailSendTransport : IRealtimeTransport
    {
        private readonly TaskCompletionSource<RealtimeTransportReceiveResult> _receive =
            new();

        public Task SendAsync(byte[] payload, CancellationToken cancellationToken)
        {
            _receive.TrySetResult(RealtimeTransportReceiveResult.Closed(
                RealtimeCloseCodes.Normal,
                "normal_close",
                clean: true));
            return Task.FromException(new InvalidOperationException("The socket closed during send."));
        }

        public Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken) =>
            _receive.Task;

        public Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public void Dispose()
        {
        }
    }

    private sealed class CloseDuringReplayTransport : IRealtimeTransport
    {
        private readonly TaskCompletionSource<RealtimeTransportReceiveResult> _receive =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Func<RealtimeClientState>? StateProvider { get; set; }

        public Task SendAsync(byte[] payload, CancellationToken cancellationToken)
        {
            _receive.TrySetResult(RealtimeTransportReceiveResult.Closed(
                RealtimeCloseCodes.Normal,
                "normal_close",
                clean: true));
            if (!SpinWait.SpinUntil(
                    () => StateProvider?.Invoke() == RealtimeClientState.Stopping,
                    TimeSpan.FromSeconds(2)))
            {
                return Task.FromException(new InvalidOperationException(
                    "The receive loop did not observe the close during replay."));
            }
            return Task.CompletedTask;
        }

        public Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken) =>
            _receive.Task;

        public Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public void Dispose()
        {
        }
    }

    private sealed class FakeTransport : IRealtimeTransport
    {
        private readonly Channel<byte[]> _sent = Channel.CreateUnbounded<byte[]>();
        private readonly Channel<RealtimeTransportReceiveResult> _received =
            Channel.CreateUnbounded<RealtimeTransportReceiveResult>();
        private readonly TaskCompletionSource<Exception> _receiveFailure =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _sentCount;
        private int _sendAttempts;
        private int _receiveCount;

        public ChannelWriter<RealtimeTransportReceiveResult> ReceiveWriter => _received.Writer;

        public bool BlockSends { get; set; }

        public bool IgnoreSendCancellation { get; set; }

        public int? FailOnSendNumber { get; set; }

        public bool BlockClose { get; set; }

        public TaskCompletionSource<bool> SendStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> ReleaseSends { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> CloseStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> ReleaseClose { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int SentCount => Volatile.Read(ref _sentCount);

        public int ReceiveCount => Volatile.Read(ref _receiveCount);

        public int? LastCloseCode { get; private set; }

        public void FailReceive(Exception? exception = null) =>
            _receiveFailure.TrySetResult(exception ?? new InvalidOperationException("Expected receive failure."));

        public async Task SendAsync(byte[] payload, CancellationToken cancellationToken)
        {
            var attempt = Interlocked.Increment(ref _sendAttempts);
            SendStarted.TrySetResult(true);
            if (BlockSends)
            {
                if (IgnoreSendCancellation)
                {
                    await ReleaseSends.Task;
                }
                else
                {
                    await ReleaseSends.Task.WaitAsync(cancellationToken);
                }
            }
            if (attempt == FailOnSendNumber)
            {
                throw new InvalidOperationException("Expected send failure.");
            }
            Interlocked.Increment(ref _sentCount);
            await _sent.Writer.WriteAsync(payload, cancellationToken);
        }

        public async Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _receiveCount);
            var receive = _received.Reader.ReadAsync(cancellationToken).AsTask();
            if (await Task.WhenAny(receive, _receiveFailure.Task) == _receiveFailure.Task)
            {
                throw await _receiveFailure.Task;
            }
            return await receive;
        }

        public async Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken)
        {
            LastCloseCode = closeCode;
            CloseStarted.TrySetResult(true);
            if (BlockClose)
            {
                await ReleaseClose.Task.WaitAsync(cancellationToken);
            }
        }

        public async Task<byte[]> WaitForSentAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            return await _sent.Reader.ReadAsync(timeout.Token);
        }

        public void Dispose()
        {
            _sent.Writer.TryComplete();
            _received.Writer.TryComplete();
            if (ThrowOnDispose)
            {
                throw new InvalidOperationException("Expected disposal failure.");
            }
        }

        public bool ThrowOnDispose { get; set; }
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

    private sealed class RecordingClock : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public List<TimeSpan> Delays { get; } = new();

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            if (delay >= TimeSpan.FromSeconds(300))
            {
                return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            Delays.Add(delay);
            return Task.CompletedTask;
        }
    }

    private sealed class AdvancingReconnectClock(DateTimeOffset now, TimeSpan advance) : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow { get; private set; } = now;

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            if (delay >= TimeSpan.FromSeconds(300))
            {
                return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            UtcNow += advance;
            return Task.CompletedTask;
        }
    }

    private sealed class BlockingReconnectClock : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public TaskCompletionSource<bool> DelayStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            DelayStarted.TrySetResult(true);
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class OneHeartbeatClock : IRealtimeClientClock
    {
        private int _delayCount;

        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) =>
            Interlocked.Increment(ref _delayCount) == 1
                ? Task.CompletedTask
                : Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
    }

    private sealed class TwoHeartbeatClock : IRealtimeClientClock
    {
        private int _delayCount;

        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public TaskCompletionSource<bool> ThirdDelayStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _delayCount) <= 2)
            {
                return Task.CompletedTask;
            }
            ThirdDelayStarted.TrySetResult(true);
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class ThrowingReconnectClock : IRealtimeClientClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            if (delay == TimeSpan.Zero)
            {
                throw new InvalidOperationException("Expected retry clock failure.");
            }
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class FixedRetryPolicy : IRealtimeRetryPolicy
    {
        public TimeSpan GetDelay(int attempt, RealtimeTransportClose? close) => TimeSpan.Zero;
    }

    private sealed class ThrowingRetryPolicy : IRealtimeRetryPolicy
    {
        public TimeSpan GetDelay(int attempt, RealtimeTransportClose? close) =>
            throw new InvalidOperationException("Expected retry policy failure.");
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
