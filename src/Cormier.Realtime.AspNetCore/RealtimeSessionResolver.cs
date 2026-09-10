using Cormier.Realtime.Contracts;
using Cormier.Realtime.Redis;
using Microsoft.AspNetCore.Http.Features;

namespace Cormier.Realtime.Gateway;

public sealed record RealtimeSessionResolution(string SessionId, RealtimeIdentity Identity);

public interface IRealtimeSessionResolver
{
    ValueTask<RealtimeSessionResolution?> ResolveAsync(HttpContext context, CancellationToken cancellationToken);

    ValueTask<RealtimeIdentity?> RevalidateAsync(string sessionId, CancellationToken cancellationToken);
}

public sealed class RealtimeSessionResolver(
    IRealtimeSessionStore sessionStore,
    RealtimeOptions options) : IRealtimeSessionResolver
{
    public async ValueTask<RealtimeSessionResolution?> ResolveAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        var sessionId = options.SessionSource switch
        {
            RealtimeSessionSource.Cookie => context.Request.Cookies[options.SessionCookieName],
            RealtimeSessionSource.AspNetCoreSession => await ResolveAspNetCoreSessionIdAsync(context, cancellationToken),
            _ => null,
        };
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var identity = await sessionStore.ValidateAsync(sessionId, cancellationToken);
        return identity is null ? null : new RealtimeSessionResolution(sessionId, identity);
    }

    public ValueTask<RealtimeIdentity?> RevalidateAsync(
        string sessionId,
        CancellationToken cancellationToken) =>
        sessionStore.ValidateAsync(sessionId, cancellationToken);

    private async ValueTask<string?> ResolveAspNetCoreSessionIdAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        var feature = context.Features.Get<ISessionFeature>();
        if (feature?.Session is null)
        {
            throw new InvalidOperationException(
                "ASP.NET Core session resolution requires AddSession and UseSession before mapped realtime endpoints execute.");
        }

        await feature.Session.LoadAsync(cancellationToken);
        return feature.Session.GetString(options.AspNetCoreSessionIdKey) ?? feature.Session.Id;
    }
}
