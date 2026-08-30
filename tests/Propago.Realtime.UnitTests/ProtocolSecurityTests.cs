using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Propago.Realtime.Contracts;
using Propago.Realtime.Gateway;

namespace Propago.Realtime.UnitTests;

public sealed class ProtocolSecurityTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 30, 12, 0, 0, TimeSpan.Zero);
    private static readonly JsonElement Payload = JsonSerializer.SerializeToElement(new { value = 42 });

    [Fact]
    public void ProtocolValidatorAcceptsCurrentVersion()
    {
        var result = ProtocolValidator.Validate(Envelope(), Now);

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
        Assert.Contains("propago_realtime_queue_dropped_total 1", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(connection.Identity.TenantId, rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(connection.Identity.UserId, rendered, StringComparison.Ordinal);
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
        Assert.Contains("propago_realtime_websocket_closes_total 1", metrics.RenderPrometheus(), StringComparison.Ordinal);
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
        string type = ProtocolMessageTypes.Publish) =>
        new(version, type, "correlation-1", Now, "topics/orders", Payload);

    private static RealtimeIdentity Identity() =>
        new("tenant-1", "user-1", ["orders"], Now.AddHours(1));

    private sealed class OpenWebSocket : WebSocket
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
}
