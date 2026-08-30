using Propago.Realtime.Contracts;
using Propago.Realtime.Redis;

namespace Propago.Realtime.Gateway;

public sealed record AuthenticationResult(
    RealtimeIdentity? Identity,
    string? FailureCode,
    string? SessionId = null)
{
    public bool Succeeded => Identity is not null;
}

public sealed class RealtimeAuthenticator(
    IRealtimeSessionStore sessionStore,
    IConnectionTicketStore ticketStore,
    RealtimeOptions options,
    GatewayMetrics metrics)
{
    public async ValueTask<AuthenticationResult> AuthenticateAsync(
        HttpRequest request,
        CancellationToken cancellationToken)
    {
        var audience = request.Host.Value ?? string.Empty;
        var ticket = request.Query["ticket"].ToString();
        if (!string.IsNullOrWhiteSpace(ticket))
        {
            var identity = await ticketStore.ConsumeAsync(ticket, audience, cancellationToken);
            metrics.RecordAuthentication(identity is not null, "ticket");
            return identity is null
                ? new AuthenticationResult(null, "invalid_ticket")
                : new AuthenticationResult(identity, null);
        }

        return await AuthenticateSessionAsync(request, cancellationToken);
    }

    public async ValueTask<AuthenticationResult> AuthenticateSessionAsync(
        HttpRequest request,
        CancellationToken cancellationToken)
    {
        var origin = request.Headers.Origin.ToString();
        if (!IsAllowedOrigin(origin) || !IsSameOrigin(request, origin))
        {
            metrics.RecordAuthentication(false, "origin");
            return new AuthenticationResult(null, "origin_rejected");
        }

        if (!request.Cookies.TryGetValue(options.SessionCookieName, out var sessionId) ||
            string.IsNullOrWhiteSpace(sessionId))
        {
            metrics.RecordAuthentication(false, "session");
            return new AuthenticationResult(null, "session_missing");
        }

        var sessionIdentity = await sessionStore.ValidateAsync(sessionId, cancellationToken);
        metrics.RecordAuthentication(sessionIdentity is not null, "session");
        return sessionIdentity is null
            ? new AuthenticationResult(null, "session_invalid")
            : new AuthenticationResult(sessionIdentity, null, sessionId);
    }

    public ValueTask<RealtimeIdentity?> RevalidateSessionAsync(
        string sessionId,
        CancellationToken cancellationToken) =>
        sessionStore.ValidateAsync(sessionId, cancellationToken);

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
