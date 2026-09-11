using System.Diagnostics;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Redis;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed record AuthenticationResult(
    RealtimeIdentity? Identity,
    string? FailureCode,
    string? SessionId = null)
{
    public bool Succeeded => Identity is not null;
}

public sealed class RealtimeAuthenticator(
    IRealtimeSessionResolver sessionResolver,
    IConnectionTicketStore ticketStore,
    RealtimeOptions options,
    GatewayMetrics metrics)
{
    public async ValueTask<AuthenticationResult> AuthenticateAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        var request = context.Request;
        var audience = request.Host.Value ?? string.Empty;
        var ticket = request.Query["ticket"].ToString();
        if (!string.IsNullOrWhiteSpace(ticket))
        {
            RealtimeIdentity? identity;
            try
            {
                identity = await ObserveRedisAsync(
                    "ticket_consume",
                    () => ticketStore.ConsumeAsync(ticket, audience, cancellationToken));
            }
            catch (RedisException)
            {
                metrics.RecordAuthentication(false, "ticket");
                throw;
            }
            metrics.RecordAuthentication(identity is not null, "ticket", IsReconnectRequest(request));
            return identity is null
                ? new AuthenticationResult(null, "invalid_ticket")
                : new AuthenticationResult(identity, null, identity.SessionId);
        }

        return await AuthenticateSessionAsync(context, cancellationToken);
    }

    public async ValueTask<AuthenticationResult> AuthenticateSessionAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        var request = context.Request;
        var origin = request.Headers.Origin.ToString();
        if (!IsAllowedOrigin(origin) || !IsSameOrigin(request, origin))
        {
            metrics.RecordAuthentication(false, "origin");
            return new AuthenticationResult(null, "origin_rejected");
        }
        metrics.RecordAuthentication(true, "origin");

        RealtimeSessionResolution? session;
        try
        {
            session = await ObserveRedisAsync(
                "session_read",
                () => sessionResolver.ResolveAsync(context, cancellationToken));
        }
        catch (RedisException)
        {
            metrics.RecordAuthentication(false, "session");
            throw;
        }
        metrics.RecordAuthentication(session is not null, "session", IsReconnectRequest(request));
        return session is null
            ? new AuthenticationResult(null, "session_invalid")
            : new AuthenticationResult(
                session.Identity with { SessionId = session.SessionId },
                null,
                session.SessionId);
    }

    public ValueTask<RealtimeIdentity?> RevalidateSessionAsync(
        string sessionId,
        CancellationToken cancellationToken) =>
        ObserveRedisAsync("session_read", () => sessionResolver.RevalidateAsync(sessionId, cancellationToken));

    public ValueTask<string> IssueTicketAsync(
        RealtimeIdentity identity,
        string audience,
        TimeSpan lifetime,
        CancellationToken cancellationToken) =>
        ObserveRedisAsync(
            "ticket_issue",
            () => ticketStore.IssueAsync(identity, audience, lifetime, cancellationToken));

    private async ValueTask<T> ObserveRedisAsync<T>(string operation, Func<ValueTask<T>> action)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var result = await action();
            metrics.RecordRedisOperation(operation, true);
            metrics.RecordRedisDuration(operation, Stopwatch.GetElapsedTime(started), true);
            return result;
        }
        catch (RedisException)
        {
            metrics.RecordRedisOperation(operation, false);
            metrics.RecordRedisDuration(operation, Stopwatch.GetElapsedTime(started), false);
            throw;
        }
    }

    public bool IsAllowedOrigin(string origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var candidate))
        {
            return false;
        }

        return options.AllowedOrigins.Any(allowed =>
            Uri.TryCreate(allowed, UriKind.Absolute, out var configured) &&
            string.Equals(candidate.Scheme, configured.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(candidate.Host, configured.Host, StringComparison.OrdinalIgnoreCase) &&
            candidate.Port == configured.Port);
    }

    public static bool IsSameOrigin(HttpRequest request, string origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var candidate))
        {
            return false;
        }

        var requestScheme = request.Scheme switch
        {
            "ws" => "http",
            "wss" => "https",
            _ => request.Scheme,
        };
        var requestPort = request.Host.Port ??
            (string.Equals(requestScheme, "https", StringComparison.OrdinalIgnoreCase) ? 443 : 80);
        return string.Equals(candidate.Scheme, requestScheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(candidate.Host, request.Host.Host, StringComparison.OrdinalIgnoreCase) &&
            candidate.Port == requestPort;
    }

    private static bool IsReconnectRequest(HttpRequest request) =>
        bool.TryParse(request.Query["reconnect"].ToString(), out var reconnecting) && reconnecting;
}

public readonly record struct AuthorizedRoute(string Topic, string? UserId)
{
    public string SubscriptionKey => UserId is null ? $"topics/{Topic}" : $"users/{UserId}/topics/{Topic}";
}

public static class RealtimeRouteAuthorizer
{
    public static bool TryAuthorize(
        RealtimeIdentity identity,
        string route,
        out AuthorizedRoute authorizedRoute)
    {
        authorizedRoute = default;
        var segments = route.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        string topic;
        string? userId = null;
        if (segments.Length == 2 && string.Equals(segments[0], "topics", StringComparison.Ordinal))
        {
            topic = segments[1];
        }
        else if (segments.Length == 4 &&
            string.Equals(segments[0], "users", StringComparison.Ordinal) &&
            string.Equals(segments[2], "topics", StringComparison.Ordinal))
        {
            var requestedUser = segments[1];
            if (!string.Equals(requestedUser, identity.UserId, StringComparison.Ordinal))
            {
                return false;
            }

            userId = requestedUser;
            topic = segments[3];
        }
        else
        {
            return false;
        }

        if (!IsSafeSegment(topic) ||
            !identity.AllowedTopics.Any(allowed =>
                allowed == "*" || string.Equals(allowed, topic, StringComparison.Ordinal)))
        {
            return false;
        }

        authorizedRoute = new AuthorizedRoute(topic, userId);
        return true;
    }

    private static bool IsSafeSegment(string value) =>
        value.Length is >= 1 and <= 128 &&
        value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');
}
