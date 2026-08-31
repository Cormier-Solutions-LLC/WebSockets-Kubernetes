using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;

namespace Cormier.Realtime.UnitTests;

public sealed class ProtocolSecurityTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 30, 12, 0, 0, TimeSpan.Zero);
    private static readonly JsonElement Payload = JsonSerializer.SerializeToElement(new { value = 42 });

    [Fact]
    public void ProtocolValidatorAcceptsCurrentVersion()
    {
        var result = ProtocolValidator.Validate(
            Envelope(correlationId: "correlation:tenant/orders/1"),
            Now);

        Assert.True(result.IsValid);
    }

    [Theory]
    [InlineData("0.9", ProtocolErrorCodes.UnsupportedVersion)]
    [InlineData("1.0", ProtocolErrorCodes.UnsupportedType, "unknown")]
    public void ProtocolValidatorReturnsStructuredCompatibilityErrors(
        string version,
        string expectedCode,
        string type = ProtocolMessageTypes.Publish)
    {
        var result = ProtocolValidator.Validate(Envelope(version, type), Now);

        Assert.False(result.IsValid);
        Assert.Equal(expectedCode, result.ErrorCode);
    }

    [Fact]
    public void PublishRequiresPayload()
    {
        var envelope = new MessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Publish,
            "correlation-1",
            Now,
            "topics/orders",
            default);

        var result = ProtocolValidator.Validate(envelope, Now);

        Assert.False(result.IsValid);
        Assert.Equal(ProtocolErrorCodes.InvalidEnvelope, result.ErrorCode);
    }

    [Fact]
    public void RouteAuthorizationUsesServerTenantAndCurrentUser()
    {
        var identity = Identity();

        Assert.True(RealtimeRouteAuthorizer.TryAuthorize(identity, "topics/orders", out var tenantRoute));
        Assert.Equal("orders", tenantRoute.Topic);
        Assert.True(RealtimeRouteAuthorizer.TryAuthorize(identity, "users/user-1/topics/orders", out _));
        Assert.False(RealtimeRouteAuthorizer.TryAuthorize(identity, "users/user-2/topics/orders", out _));
        Assert.False(RealtimeRouteAuthorizer.TryAuthorize(identity, "topics/admin", out _));
        Assert.False(RealtimeRouteAuthorizer.TryAuthorize(identity, "tenants/tenant-2/topics/orders", out _));
    }

    [Fact]
    public void DurableConfigurationRequiresEnabledStreamsAndSafeClassNames()
    {
        var disabled = new RealtimeOptionsValidator(Options.Create(new RedisOptions { StreamsEnabled = false }));
        var enabled = new RealtimeOptionsValidator(Options.Create(new RedisOptions { StreamsEnabled = true }));

        Assert.True(disabled.Validate(null, new RealtimeOptions()).Succeeded);
        Assert.False(disabled.Validate(null, new RealtimeOptions { DurableEventClasses = ["audit"] }).Succeeded);
        Assert.False(enabled.Validate(null, new RealtimeOptions { DurableEventClasses = ["order.created"] }).Succeeded);
        Assert.True(enabled.Validate(null, new RealtimeOptions { DurableEventClasses = ["order-created"] }).Succeeded);
        Assert.False(enabled.Validate(null, new RealtimeOptions { MaximumSubscriptions = 0 }).Succeeded);
        Assert.False(enabled.Validate(null, new RealtimeOptions { MaximumTrackedCorrelations = 0 }).Succeeded);
        Assert.False(enabled.Validate(null, new RealtimeOptions { SlowConsumerStrikeLimit = 0 }).Succeeded);
    }

    [Fact]
    public void SourceInstanceIsBoundedForLongMachineNames()
    {
        var source = RealtimeDispatcher.BuildSourceInstance(
            new string('s', 128),
            new string('m', 253));

        Assert.Equal(256, source.Length);
        Assert.StartsWith(new string('s', 128) + ":", source, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https", "gateway.example", null, "https://gateway.example", true)]
    [InlineData("https", "gateway.example", 8443, "https://gateway.example:8443", true)]
    [InlineData("https", "gateway.example", null, "https://evil.example", false)]
    [InlineData("https", "gateway.example", null, "http://gateway.example", false)]
    public void CookieOriginMustMatchRequestOrigin(
        string scheme,
        string host,
        int? port,
        string origin,
        bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = scheme;
        context.Request.Host = port.HasValue ? new HostString(host, port.Value) : new HostString(host);

        Assert.Equal(expected, RealtimeAuthenticator.IsSameOrigin(context.Request, origin));
    }

    [Fact]
    public async Task ConnectionQueueIsBoundedAndTracksDuplicateCorrelations()
    {
        using var metrics = new GatewayMetrics();
        await using var connection = new RealtimeConnection(
            new OpenWebSocket(),
            Identity(),
            new RealtimeOptions { OutboundQueueCapacity = 1, SlowConsumerStrikeLimit = 1 },
            metrics);
        var message = RealtimeDispatcher.Error(null, ProtocolErrorCodes.InternalError, "temporary");

        Assert.True(connection.TryTrackCorrelation("correlation-1"));
        Assert.False(connection.TryTrackCorrelation("correlation-1"));
        Assert.True(connection.TryEnqueue(message));
        Assert.False(connection.TryEnqueue(message));
        Assert.True(connection.HasExceededSlowConsumerLimit);
        var rendered = metrics.RenderPrometheus();
        Assert.Contains("cormier_realtime_queue_dropped_total 1", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(connection.Identity.TenantId, rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(connection.Identity.UserId, rendered, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ClosingConnectionDoesNotReportQueueSaturation()
    {
        using var metrics = new GatewayMetrics();
        await using var connection = new RealtimeConnection(
            new OpenWebSocket(),
            Identity(),
            new RealtimeOptions { OutboundQueueCapacity = 1, SlowConsumerStrikeLimit = 1 },
            metrics);

        await connection.RequestCloseAsync(WebSocketCloseStatus.NormalClosure, "test_close", CancellationToken.None);

        Assert.False(connection.TryEnqueue(RealtimeDispatcher.Error(null, ProtocolErrorCodes.InternalError, "ignored")));
        Assert.Contains("cormier_realtime_queue_dropped_total 0", metrics.RenderPrometheus(), StringComparison.Ordinal);
        Assert.False(connection.HasExceededSlowConsumerLimit);
    }

    [Fact]
    public async Task FailedCloseFrameRecordsOnlyTheFailureOutcome()
    {
        using var metrics = new GatewayMetrics();
        await using var connection = new RealtimeConnection(
            new FailingCloseWebSocket(),
            Identity(),
            new RealtimeOptions(),
            metrics);

        await connection.RequestCloseAsync(WebSocketCloseStatus.NormalClosure, "test_close", CancellationToken.None);

        var rendered = metrics.RenderPrometheus();
        Assert.Contains("cormier_realtime_websocket_closes_total{code=\"1000\"} 0", rendered, StringComparison.Ordinal);
        Assert.Contains("cormier_realtime_websocket_closes_total{code=\"1011\"} 1", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RegistryDisconnectsSlowConsumerWithoutCrossTenantDelivery()
    {
        using var metrics = new GatewayMetrics();
        var socket = new OpenWebSocket();
        await using var connection = new RealtimeConnection(
            socket,
            Identity(),
            new RealtimeOptions { OutboundQueueCapacity = 1, SlowConsumerStrikeLimit = 1 },
            metrics);
        Assert.True(connection.TrySubscribe(new AuthorizedRoute("orders", null)));
        var registry = new RealtimeConnectionRegistry(metrics);
        Assert.True(registry.Add(connection));
        Assert.True(connection.TryEnqueue(RealtimeDispatcher.Error(null, ProtocolErrorCodes.InternalError, "fill")));

        await registry.DeliverAsync(
            new RealtimeBusMessage(
                "message-1",
                "tenant-1",
                null,
                "orders",
                "correlation-1",
                Now,
                Payload,
                "instance-a"),
            CancellationToken.None);

        Assert.Equal(RealtimeCloseStatus.SlowConsumer, socket.CloseStatus);
        Assert.Contains("cormier_realtime_websocket_closes_total{code=\"4008\"} 1", metrics.RenderPrometheus(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task StalledSlowConsumerDoesNotBlockOtherFanout()
    {
        using var metrics = new GatewayMetrics();
        var slowSocket = new SignalingWebSocket(blockSend: true);
        var fastSocket = new SignalingWebSocket(blockSend: false);
        var options = new RealtimeOptions { OutboundQueueCapacity = 1, SlowConsumerStrikeLimit = 1 };
        await using var slow = new RealtimeConnection(slowSocket, Identity(), options, metrics);
        await using var fast = new RealtimeConnection(fastSocket, Identity(), options, metrics);
        Assert.True(slow.TrySubscribe(new AuthorizedRoute("orders", null)));
        Assert.True(fast.TrySubscribe(new AuthorizedRoute("orders", null)));
        var registry = new RealtimeConnectionRegistry(metrics);
        Assert.True(registry.Add(slow));
        Assert.True(registry.Add(fast));
        using var senders = new CancellationTokenSource();
        Assert.True(slow.TryEnqueue(RealtimeDispatcher.Error(null, ProtocolErrorCodes.InternalError, "sending")));
        var slowSender = slow.RunSenderAsync(senders.Token);
        await slowSocket.SendEntered.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.True(slow.TryEnqueue(RealtimeDispatcher.Error(null, ProtocolErrorCodes.InternalError, "queued")));
        var fastSender = fast.RunSenderAsync(senders.Token);

        var delivery = registry.DeliverAsync(
            new RealtimeBusMessage(
                "message-2",
                "tenant-1",
                null,
                "orders",
                "correlation-2",
                Now,
                Payload,
                "instance-a"),
            CancellationToken.None).AsTask();

        await fastSocket.SendEntered.WaitAsync(TimeSpan.FromMilliseconds(500));
        slowSocket.ReleaseSend();
        await delivery.WaitAsync(TimeSpan.FromSeconds(2));
        await senders.CancelAsync();
        await IgnoreCancellationAsync(slowSender);
        await IgnoreCancellationAsync(fastSender);
    }

    [Fact]
    public async Task CanceledCloseCanBeRetried()
    {
        using var metrics = new GatewayMetrics();
        var socket = new OpenWebSocket();
        await using var connection = new RealtimeConnection(
            socket,
            Identity(),
            new RealtimeOptions(),
            metrics);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await connection.RequestCloseAsync(
                RealtimeCloseStatus.ServiceRestart,
                "cancelled_attempt",
                cancelled.Token));
        await connection.RequestCloseAsync(
            RealtimeCloseStatus.ServiceRestart,
            "retry",
            CancellationToken.None);

        Assert.Equal(RealtimeCloseStatus.ServiceRestart, socket.CloseStatus);
    }

    private static MessageEnvelope Envelope(
        string version = ProtocolVersions.Current,
        string type = ProtocolMessageTypes.Publish,
        string correlationId = "correlation-1") =>
        new(version, type, correlationId, Now, "topics/orders", Payload);

    private static RealtimeIdentity Identity() =>
        new("tenant-1", "user-1", ["orders"], DateTimeOffset.UtcNow.AddHours(1));

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
            System.Diagnostics.Debug.WriteLine("Test WebSocket sender canceled as expected.");
        }
    }

    private class OpenWebSocket : WebSocket
    {
        private WebSocketCloseStatus? _closeStatus;
        private string? _closeStatusDescription;
        private WebSocketState _state = WebSocketState.Open;

        public override WebSocketCloseStatus? CloseStatus => _closeStatus;

        public override string? CloseStatusDescription => _closeStatusDescription;

        public override WebSocketState State => _state;

        public override string? SubProtocol => RealtimeWebSocketHandler.SubProtocol;

        public override void Abort() => _state = WebSocketState.Aborted;

        public override Task CloseAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken)
        {
            _closeStatus = closeStatus;
            _closeStatusDescription = statusDescription;
            _state = WebSocketState.Closed;
            return Task.CompletedTask;
        }

        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken)
        {
            _closeStatus = closeStatus;
            _closeStatusDescription = statusDescription;
            _state = WebSocketState.CloseSent;
            return Task.CompletedTask;
        }

        public override void Dispose() => _state = WebSocketState.Closed;

        public override Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class SignalingWebSocket(bool blockSend) : OpenWebSocket
    {
        private readonly TaskCompletionSource _sendEntered = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseSend = CreateRelease(blockSend);

        public Task SendEntered => _sendEntered.Task;

        public void ReleaseSend() => _releaseSend.TrySetResult();

        public override async Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken)
        {
            _sendEntered.TrySetResult();
            await _releaseSend.Task.WaitAsync(cancellationToken);
        }

        private static TaskCompletionSource CreateRelease(bool block)
        {
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!block)
            {
                release.TrySetResult();
            }

            return release;
        }
    }

    private sealed class FailingCloseWebSocket : OpenWebSocket
    {
        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) =>
            throw new WebSocketException("Simulated close-frame failure.");
    }
}
