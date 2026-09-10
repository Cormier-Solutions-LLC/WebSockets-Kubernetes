using System.Net;
using System.Net.WebSockets;

namespace Cormier.Realtime.Client;

public sealed class ClientWebSocketTransportFactory : IRealtimeTransportFactory
{
    public async Task<IRealtimeTransport> ConnectAsync(
        Uri endpoint,
        RealtimeAuthenticationMaterial authentication,
        string subProtocol,
        int maximumFrameBytes,
        int maximumMessageBytes,
        CancellationToken cancellationToken)
    {
        if (endpoint is null)
        {
            throw new ArgumentNullException(nameof(endpoint));
        }
        if (authentication is null)
        {
            throw new ArgumentNullException(nameof(authentication));
        }
        var socket = new ClientWebSocket();
        try
        {
            socket.Options.AddSubProtocol(subProtocol);
            foreach (var header in authentication.Headers)
            {
                socket.Options.SetRequestHeader(header.Key, header.Value);
            }
            if (!string.IsNullOrWhiteSpace(authentication.CookieHeader))
            {
                socket.Options.SetRequestHeader("Cookie", authentication.CookieHeader);
            }

            var authenticatedEndpoint = AppendTicket(endpoint, authentication.ConnectionTicket);
            await socket.ConnectAsync(authenticatedEndpoint, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(socket.SubProtocol, subProtocol, StringComparison.Ordinal))
            {
                throw new RealtimeProtocolException("The server did not negotiate the required realtime subprotocol.");
            }
            return new ClientWebSocketTransport(socket, maximumFrameBytes, maximumMessageBytes);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static Uri AppendTicket(Uri endpoint, string? ticket)
    {
        if (string.IsNullOrWhiteSpace(ticket))
        {
            return endpoint;
        }

        var builder = new UriBuilder(endpoint);
        var encoded = WebUtility.UrlEncode(ticket);
        builder.Query = string.IsNullOrEmpty(builder.Query)
            ? $"ticket={encoded}"
            : $"{builder.Query.TrimStart('?')}&ticket={encoded}";
        return builder.Uri;
    }
}

public sealed class ClientWebSocketTransport : IRealtimeTransport
{
    private readonly ClientWebSocket _socket;
    private readonly int _maximumFrameBytes;
    private readonly int _maximumMessageBytes;

    internal ClientWebSocketTransport(
        ClientWebSocket socket,
        int maximumFrameBytes,
        int maximumMessageBytes)
    {
        _socket = socket;
        _maximumFrameBytes = maximumFrameBytes;
        _maximumMessageBytes = maximumMessageBytes;
    }

    public Task SendAsync(byte[] payload, CancellationToken cancellationToken)
    {
        if (payload is null)
        {
            throw new ArgumentNullException(nameof(payload));
        }
        return _socket.SendAsync(
            new ArraySegment<byte>(payload),
            WebSocketMessageType.Text,
            endOfMessage: true,
            cancellationToken);
    }

    public async Task<RealtimeTransportReceiveResult> ReceiveAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[_maximumFrameBytes];
        var result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken)
            .ConfigureAwait(false);
        if (result.MessageType == WebSocketMessageType.Close)
        {
            return RealtimeTransportReceiveResult.Closed(
                result.CloseStatus.HasValue ? (int)result.CloseStatus.Value : null,
                NormalizeCloseReason(result.CloseStatusDescription),
                _socket.CloseStatus.HasValue);
        }
        if (result.MessageType != WebSocketMessageType.Text)
        {
            throw new RealtimeProtocolException("The server returned an unsupported WebSocket message type.");
        }
        if (!result.EndOfMessage)
        {
            throw new RealtimeProtocolException("The server returned a fragmented or oversized WebSocket frame.");
        }
        if (result.Count > _maximumMessageBytes)
        {
            throw new RealtimeProtocolException("The server message exceeded the configured size limit.");
        }
        var payload = new byte[result.Count];
        Buffer.BlockCopy(buffer, 0, payload, 0, result.Count);
        return RealtimeTransportReceiveResult.Message(payload);
    }

    public async Task CloseAsync(int closeCode, string reason, CancellationToken cancellationToken)
    {
        if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await _socket.CloseOutputAsync((WebSocketCloseStatus)closeCode, reason, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    public void Dispose() => _socket.Dispose();

    private static string NormalizeCloseReason(string? reason) =>
        string.IsNullOrWhiteSpace(reason) ? "connection_closed" : "server_close";
}
