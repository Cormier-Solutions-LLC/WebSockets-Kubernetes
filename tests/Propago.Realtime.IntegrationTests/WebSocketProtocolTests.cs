using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Propago.Realtime.Contracts;
using Propago.Realtime.Gateway;
using Propago.Realtime.Redis;

namespace Propago.Realtime.IntegrationTests;

public sealed class WebSocketProtocolTests
{
    [Fact]
    public async Task AuthorizedPublishReturnsCorrelatedAcknowledgment()
    {
        await using var factory = new RealtimeFactory();
        Assert.Equal(1024, factory.Services.GetRequiredService<RealtimeOptions>().MaximumFrameBytes);
        using var socket = await ConnectAsync(factory);
        var command = Envelope(ProtocolMessageTypes.Publish, "correlation-1");

        await SendAsync(socket, command);
        var response = await ReceiveEnvelopeAsync(socket);

        Assert.Equal(ProtocolMessageTypes.Acknowledge, response.Type);
        Assert.Equal(command.CorrelationId, response.CorrelationId);
        Assert.Single(factory.Bus.Published);
        Assert.Equal("tenant-1", factory.Bus.Published.Single().TenantId);
    }

    [Fact]
    public async Task MalformedUnsupportedAndDuplicateFramesReturnStructuredErrors()
    {
        await using var factory = new RealtimeFactory();
        using var socket = await ConnectAsync(factory);
        await socket.SendAsync(Encoding.UTF8.GetBytes("{not-json"), WebSocketMessageType.Text, true, CancellationToken.None);
        Assert.Equal(ProtocolErrorCodes.InvalidEnvelope, (await ReceiveEnvelopeAsync(socket)).Error?.Code);

        await SendAsync(socket, Envelope("unknown", "correlation-2"));
        Assert.Equal(ProtocolErrorCodes.UnsupportedType, (await ReceiveEnvelopeAsync(socket)).Error?.Code);

        var valid = Envelope(ProtocolMessageTypes.Ping, "correlation-3");
        await SendAsync(socket, valid);
        Assert.Equal(ProtocolMessageTypes.Acknowledge, (await ReceiveEnvelopeAsync(socket)).Type);
        await SendAsync(socket, valid);
        Assert.Equal(ProtocolErrorCodes.DuplicateCorrelation, (await ReceiveEnvelopeAsync(socket)).Error?.Code);
    }

    [Fact]
    public async Task FragmentedAndOversizedFramesAreClosedWithExplicitStatus()
    {
        await using var factory = new RealtimeFactory();
        Assert.Equal(1024, factory.Services.GetRequiredService<RealtimeOptions>().MaximumFrameBytes);
        using (var fragmented = await ConnectAsync(factory))
        {
            await fragmented.SendAsync(
                Encoding.UTF8.GetBytes("{}"),
                WebSocketMessageType.Text,
                endOfMessage: false,
                CancellationToken.None);
            await WaitForCloseAsync(fragmented);
            Assert.Equal(WebSocketCloseStatus.InvalidPayloadData, fragmented.CloseStatus);
        }

        await using var oversizedFactory = new RealtimeFactory();
        using var oversized = await ConnectAsync(oversizedFactory);
        await oversized.SendAsync(
            new byte[1025],
            WebSocketMessageType.Text,
            endOfMessage: true,
            CancellationToken.None);
        await WaitForCloseAsync(oversized);
        Assert.Equal(WebSocketCloseStatus.MessageTooBig, oversized.CloseStatus);
    }

    [Fact]
    public async Task MissingCookieAndCrossOriginCookieAreRejected()
    {
        await using var factory = new RealtimeFactory();

        await Assert.ThrowsAnyAsync<Exception>(() => ConnectAsync(factory, includeCookie: false, useTicket: false));
        await Assert.ThrowsAnyAsync<Exception>(() => ConnectAsync(factory, origin: "https://evil.example", useTicket: false));
    }

    [Fact]
    public async Task ExistingTicketCannotMintReplacementTicket()
    {
        await using var factory = new RealtimeFactory();
        using var client = factory.CreateClient();

        using var response = await client.PostAsync(
            "/realtime/tickets?ticket=valid-ticket",
            content: null,
            CancellationToken.None);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task IdleConnectionClosesWithHeartbeatTimeout()
    {
        await using var factory = new RealtimeFactory();
        using var socket = await ConnectAsync(factory);

        await WaitForCloseAsync(socket);

        Assert.Equal(RealtimeCloseStatus.HeartbeatTimeout, socket.CloseStatus);
        var registry = factory.Services.GetRequiredService<RealtimeConnectionRegistry>();
        for (var attempt = 0; attempt < 50 && registry.Count != 0; attempt++)
        {
            await Task.Delay(20);
        }

        Assert.Equal(0, registry.Count);
    }

    [Fact]
    public async Task RestartGuidanceAndAbruptDisconnectCleanUpLocalRegistry()
    {
        await using var factory = new RealtimeFactory();
        var registry = factory.Services.GetRequiredService<RealtimeConnectionRegistry>();
        using (var drainingSocket = await ConnectAsync(factory))
        {
            Assert.Equal(1, registry.Count);
            await registry.NotifyServiceRestartAsync();
            var restart = await ReceiveEnvelopeAsync(drainingSocket);
            Assert.Equal(ProtocolMessageTypes.ServiceRestart, restart.Type);
            Assert.True(restart.Reconnect?.Reauthenticate);
            await registry.CloseAllAsync(CancellationToken.None);
            await WaitForCloseAsync(drainingSocket);
            Assert.Equal(RealtimeCloseStatus.ServiceRestart, drainingSocket.CloseStatus);
            await drainingSocket.CloseOutputAsync(
                WebSocketCloseStatus.NormalClosure,
                "restart_received",
                CancellationToken.None);
            for (var attempt = 0; attempt < 50 && registry.Count != 0; attempt++)
            {
                await Task.Delay(20);
            }
        }

        using var abruptSocket = await ConnectAsync(factory);
        Assert.Equal(1, registry.Count);
        abruptSocket.Abort();
        for (var attempt = 0; attempt < 50 && registry.Count != 0; attempt++)
        {
            await Task.Delay(20);
        }

        Assert.Equal(0, registry.Count);
    }

    private static async Task<WebSocket> ConnectAsync(
        RealtimeFactory factory,
        bool includeCookie = true,
        string origin = "http://localhost",
        bool useTicket = true)
    {
        var client = factory.Server.CreateWebSocketClient();
        client.SubProtocols.Add(RealtimeWebSocketHandler.SubProtocol);
        client.ConfigureRequest = request =>
        {
            request.Headers.Origin = origin;
            if (includeCookie)
            {
                request.Headers.Append("Cookie", "propago_session=valid-session-123456");
            }
        };
        var path = useTicket ? "/realtime/ws?ticket=valid-ticket" : "/realtime/ws";
        return await client.ConnectAsync(new Uri($"ws://localhost{path}"), CancellationToken.None);
    }

    private static MessageEnvelope Envelope(string type, string correlationId) => new(
        ProtocolVersions.Current,
        type,
        correlationId,
        DateTimeOffset.UtcNow,
        "topics/orders",
        JsonSerializer.SerializeToElement(new { value = 42 }));

    private static async Task SendAsync(WebSocket socket, MessageEnvelope envelope)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(envelope, RealtimeJsonSerializerContext.Default.MessageEnvelope);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private static async Task<ServerMessageEnvelope> ReceiveEnvelopeAsync(WebSocket socket)
    {
        var buffer = new byte[4096];
        var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Text, result.MessageType);
        return JsonSerializer.Deserialize(
            buffer.AsSpan(0, result.Count),
            RealtimeJsonSerializerContext.Default.ServerMessageEnvelope)!;
    }

    private static async Task WaitForCloseAsync(WebSocket socket)
    {
        var buffer = new byte[4096];
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (socket.State is WebSocketState.Open or WebSocketState.CloseSent)
        {
            var result = await socket.ReceiveAsync(buffer, timeout.Token);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return;
            }
        }
    }

    private sealed class RealtimeFactory : WebApplicationFactory<Program>
    {
        public FakeMessageBus Bus { get; } = new();

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["Realtime:AllowedOrigins:0"] = "http://localhost",
                    ["Realtime:MaximumFrameBytes"] = "1024",
                    ["Realtime:MaximumMessageBytes"] = "1024",
                }));
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IOptions<RealtimeOptions>>();
                services.RemoveAll<IRealtimeSessionStore>();
                services.RemoveAll<IConnectionTicketStore>();
                services.RemoveAll<IRealtimeMessageBus>();
                services.RemoveAll<IDurableRealtimeStore>();
                services.AddSingleton<IOptions<RealtimeOptions>>(Options.Create(new RealtimeOptions
                {
                    AllowedOrigins = ["http://localhost"],
                    MaximumFrameBytes = 1024,
                    MaximumMessageBytes = 1024,
                    HeartbeatSeconds = 1,
                    IdleTimeoutSeconds = 2,
                }));
                services.AddSingleton<IRealtimeSessionStore, FakeSessionStore>();
                services.AddSingleton<IConnectionTicketStore, FakeTicketStore>();
                services.AddSingleton<IRealtimeMessageBus>(Bus);
                services.AddSingleton<IDurableRealtimeStore, FakeDurableStore>();
            });
        }
    }

    private sealed class FakeSessionStore : IRealtimeSessionStore
    {
        public ValueTask<RealtimeIdentity?> ValidateAsync(string sessionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<RealtimeIdentity?>(sessionId == "valid-session-123456"
                ? new RealtimeIdentity("tenant-1", "user-1", ["orders"], DateTimeOffset.UtcNow.AddMinutes(5))
                : null);
    }

    private sealed class FakeTicketStore : IConnectionTicketStore
    {
        public ValueTask<string> IssueAsync(RealtimeIdentity identity, string audience, TimeSpan lifetime, CancellationToken cancellationToken) =>
            ValueTask.FromResult("unused-ticket");

        public ValueTask<RealtimeIdentity?> ConsumeAsync(string ticket, string audience, CancellationToken cancellationToken) =>
            ValueTask.FromResult<RealtimeIdentity?>(ticket == "valid-ticket"
                ? new RealtimeIdentity("tenant-1", "user-1", ["orders"], DateTimeOffset.UtcNow.AddMinutes(5))
                : null);
    }

    private sealed class FakeMessageBus : IRealtimeMessageBus
    {
        public ConcurrentQueue<RealtimeBusMessage> Published { get; } = new();

        public ValueTask PublishAsync(RealtimeBusMessage message, CancellationToken cancellationToken)
        {
            Published.Enqueue(message);
            return ValueTask.CompletedTask;
        }

        public ValueTask<IAsyncDisposable> SubscribeAsync(Func<RealtimeBusMessage, ValueTask> handler, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IAsyncDisposable>(new EmptySubscription());

        private sealed class EmptySubscription : IAsyncDisposable
        {
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    private sealed class FakeDurableStore : IDurableRealtimeStore
    {
        public ValueTask<string> AppendAsync(DurableStreamMessage message, CancellationToken cancellationToken) =>
            ValueTask.FromResult("1-0");

        public ValueTask<IReadOnlyList<DurableDelivery>> ReadAsync(string eventClass, string group, string consumer, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<DurableDelivery>>([]);

        public ValueTask<IReadOnlyList<DurableDelivery>> RecoverPendingAsync(string eventClass, string group, string consumer, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<DurableDelivery>>([]);

        public ValueTask<bool> TryMarkProcessedAsync(string eventClass, string messageId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(true);

        public ValueTask AcknowledgeAsync(string eventClass, string group, string entryId, CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;
    }
}
