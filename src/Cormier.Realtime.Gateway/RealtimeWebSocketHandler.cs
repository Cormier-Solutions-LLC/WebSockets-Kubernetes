using System.Buffers;
using System.Net.WebSockets;
using System.Text.Json;
using Cormier.Realtime.Contracts;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class RealtimeWebSocketHandler(
    RealtimeAuthenticator authenticator,
    RealtimeConnectionRegistry registry,
    RealtimeDispatcher dispatcher,
    RealtimeOptions options,
    GatewayState state,
    GatewayMetrics metrics)
{
    private enum IdentityRevalidation
    {
        Valid,
        Invalid,
        Unavailable,
    }

    public const string SubProtocol = "cormier.realtime.v1";

    public async Task HandleAsync(HttpContext context)
    {
        if (state.IsDraining)
        {
            metrics.RecordHandshake("rejected", "draining");
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        if (!context.WebSockets.IsWebSocketRequest)
        {
            metrics.RecordHandshake("rejected", "not_websocket");
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        if (!context.WebSockets.WebSocketRequestedProtocols.Contains(SubProtocol, StringComparer.Ordinal))
        {
            metrics.RecordHandshake("rejected", "subprotocol");
            context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            context.Response.Headers.SecWebSocketProtocol = SubProtocol;
            return;
        }

        var authentication = await authenticator.AuthenticateAsync(
            context.Request,
            context.RequestAborted);
        if (!authentication.Succeeded)
        {
            metrics.RecordHandshake("rejected", "authentication");
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        if (state.IsDraining)
        {
            metrics.RecordHandshake("rejected", "draining");
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync(SubProtocol);
        await using var connection = new RealtimeConnection(
            socket,
            authentication.Identity!,
            options,
            metrics,
            authentication.SessionId);
        if (!registry.Add(connection))
        {
            metrics.RecordHandshake("rejected", "registration");
            await connection.RequestCloseAsync(
                registry.IsDraining
                    ? RealtimeCloseStatus.ServiceRestart
                    : WebSocketCloseStatus.InternalServerError,
                registry.IsDraining
                    ? "service_restart"
                    : "connection_registration_failed",
                context.RequestAborted);
            return;
        }
        metrics.RecordHandshake("accepted", "accepted");

        using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var sender = connection.RunSenderAsync(connectionCancellation.Token);
        var heartbeat = RunHeartbeatAsync(connection, connectionCancellation);
        var closeReason = "client_disconnect";
        try
        {
            closeReason = await RunReceiverAsync(connection, connectionCancellation.Token);
        }
        catch (OperationCanceledException) when (connectionCancellation.IsCancellationRequested)
        {
            closeReason = "cancelled";
        }
        catch (WebSocketException)
        {
            closeReason = "abrupt_disconnect";
        }
        finally
        {
            connectionCancellation.Cancel();
            registry.Remove(connection.Id, closeReason);
            try
            {
                await Task.WhenAll(sender, heartbeat);
            }
            catch (OperationCanceledException) when (connectionCancellation.IsCancellationRequested)
            {
                // Linked cancellation is expected during teardown but remains observable.
                metrics.RecordHandlerCancellation();
            }
        }
    }

    private async Task<string> RunReceiverAsync(
        RealtimeConnection connection,
        CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(options.MaximumFrameBytes + 1);
        try
        {
            while (connection.IsOpen)
            {
                var result = await connection.Socket.ReceiveAsync(
                    buffer.AsMemory(0, options.MaximumFrameBytes + 1),
                    cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await connection.RequestCloseAsync(
                        connection.Socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                        "client_close",
                        cancellationToken);
                    return "client_close";
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    await connection.RequestCloseAsync(
                        WebSocketCloseStatus.InvalidMessageType,
                        "text_messages_required",
                        cancellationToken);
                    return "invalid_message_type";
                }

                if (result.Count > options.MaximumFrameBytes || result.Count > options.MaximumMessageBytes)
                {
                    await connection.RequestCloseAsync(
                        WebSocketCloseStatus.MessageTooBig,
                        "message_too_large",
                        cancellationToken);
                    return "message_too_large";
                }

                if (!result.EndOfMessage)
                {
                    connection.TryEnqueue(RealtimeDispatcher.Error(
                        null,
                        ProtocolErrorCodes.FragmentedMessageRejected,
                        "Fragmented messages are not accepted."));
                    await connection.RequestCloseAsync(
                        WebSocketCloseStatus.InvalidPayloadData,
                        "fragmented_message_rejected",
                        cancellationToken);
                    return "fragmented_message";
                }

                if (DateTimeOffset.UtcNow >= connection.Identity.ExpiresAt)
                {
                    await connection.RequestCloseAsync(
                        RealtimeCloseStatus.AuthenticationExpired,
                        "authentication_expired",
                        cancellationToken);
                    return "authentication_expired";
                }

                MessageEnvelope? envelope;
                try
                {
                    envelope = JsonSerializer.Deserialize(
                        buffer.AsSpan(0, result.Count),
                        RealtimeJsonSerializerContext.Default.MessageEnvelope);
                }
                catch (JsonException)
                {
                    metrics.RecordMessage("inbound", "malformed");
                    connection.TryEnqueue(RealtimeDispatcher.Error(
                        null,
                        ProtocolErrorCodes.InvalidEnvelope,
                        "Message JSON is malformed."));
                    continue;
                }

                var validation = ProtocolValidator.Validate(envelope, DateTimeOffset.UtcNow);
                if (!validation.IsValid)
                {
                    metrics.RecordMessage("inbound", "invalid");
                    connection.TryEnqueue(RealtimeDispatcher.Error(
                        envelope,
                        validation.ErrorCode!,
                        validation.ErrorMessage!));
                    continue;
                }

                var revalidation = await RevalidateIdentityAsync(connection, cancellationToken);
                switch (revalidation)
                {
                    case IdentityRevalidation.Invalid:
                        await connection.RequestCloseAsync(
                            RealtimeCloseStatus.AuthenticationExpired,
                            "authentication_invalid",
                            cancellationToken);
                        return "authentication_invalid";

                    case IdentityRevalidation.Unavailable:
                        await connection.RequestCloseAsync(
                            WebSocketCloseStatus.InternalServerError,
                            "authentication_unavailable",
                            cancellationToken);
                        return "authentication_unavailable";
                }

                connection.RecordActivity();

                if (!connection.TryTrackCorrelation(envelope!.CorrelationId))
                {
                    metrics.RecordMessage("inbound", "duplicate");
                    connection.TryEnqueue(RealtimeDispatcher.Error(
                        envelope,
                        ProtocolErrorCodes.DuplicateCorrelation,
                        "CorrelationId has already been processed on this connection."));
                    continue;
                }

                metrics.RecordMessage("inbound", "accepted");
                await dispatcher.DispatchAsync(connection, envelope, cancellationToken);
            }

            return "socket_closed";
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
        }
    }

    private async Task RunHeartbeatAsync(
        RealtimeConnection connection,
        CancellationTokenSource connectionCancellation)
    {
        var cancellationToken = connectionCancellation.Token;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.HeartbeatSeconds));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            var revalidation = await RevalidateIdentityAsync(connection, cancellationToken);
            switch (revalidation)
            {
                case IdentityRevalidation.Invalid:
                    await connection.RequestCloseAsync(
                        RealtimeCloseStatus.AuthenticationExpired,
                        "authentication_invalid",
                        cancellationToken);
                    connectionCancellation.Cancel();
                    return;

                case IdentityRevalidation.Unavailable:
                    await connection.RequestCloseAsync(
                        WebSocketCloseStatus.InternalServerError,
                        "authentication_unavailable",
                        cancellationToken);
                    connectionCancellation.Cancel();
                    return;
            }

            if (DateTimeOffset.UtcNow >= connection.Identity.ExpiresAt)
            {
                await connection.RequestCloseAsync(
                    RealtimeCloseStatus.AuthenticationExpired,
                    "authentication_expired",
                    cancellationToken);
                connectionCancellation.Cancel();
                return;
            }

            if (DateTimeOffset.UtcNow - connection.LastActivity > TimeSpan.FromSeconds(options.IdleTimeoutSeconds))
            {
                metrics.RecordHeartbeatTimeout();
                await connection.RequestCloseAsync(
                    RealtimeCloseStatus.HeartbeatTimeout,
                    "heartbeat_timeout",
                    cancellationToken);
                connectionCancellation.Cancel();
                return;
            }

            if (!connection.TryEnqueue(new ServerMessageEnvelope(
                    ProtocolVersions.Current,
                    ProtocolMessageTypes.Ping,
                    Guid.NewGuid().ToString("N"),
                    DateTimeOffset.UtcNow,
                    "system/heartbeat")) &&
                connection.HasExceededSlowConsumerLimit)
            {
                await connection.RequestCloseAsync(
                    RealtimeCloseStatus.SlowConsumer,
                    "slow_consumer",
                    cancellationToken);
                connectionCancellation.Cancel();
                return;
            }
        }
    }

    private async ValueTask<IdentityRevalidation> RevalidateIdentityAsync(
        RealtimeConnection connection,
        CancellationToken cancellationToken)
    {
        if (connection.SessionId is null)
        {
            return DateTimeOffset.UtcNow < connection.Identity.ExpiresAt
                ? IdentityRevalidation.Valid
                : IdentityRevalidation.Invalid;
        }

        try
        {
            var refreshed = await authenticator.RevalidateSessionAsync(
                connection.SessionId,
                cancellationToken);
            if (refreshed is null ||
                !string.Equals(refreshed.TenantId, connection.Identity.TenantId, StringComparison.Ordinal) ||
                !string.Equals(refreshed.UserId, connection.Identity.UserId, StringComparison.Ordinal))
            {
                return IdentityRevalidation.Invalid;
            }

            connection.UpdateIdentity(refreshed);
            return IdentityRevalidation.Valid;
        }
        catch (RedisException)
        {
            return IdentityRevalidation.Unavailable;
        }
    }
}
