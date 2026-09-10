# Cormier.Realtime ASP.NET Core integration

`Cormier.Realtime.AspNetCore` adds the existing realtime gateway to an ASP.NET Core application without copying gateway infrastructure.

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
builder.Services.AddRealtimeGateway(builder.Configuration);

var app = builder.Build();
app.UseRealtimeGateway();
app.UseAuthentication();
app.UseAuthorization();
app.UseSession();
app.MapRealtimeGateway();
```

Configure the `Gateway`, `Redis`, `Proxy`, and `Realtime` sections. Network locations, routes, cookie names, origins, Redis keys, and deployment names remain configuration values.

For standard ASP.NET Core session middleware, call `AddSession` during service registration and place `UseSession` before the mapped endpoints execute. Set `Realtime:SessionSource` to `AspNetCoreSession`. The resolver reads `Cormier.Realtime.SessionId` from `HttpContext.Session`, falling back to `ISession.Id`, and validates that identifier through the existing `IRealtimeSessionStore`; expiration, revocation, tenant scope, and reconnect therefore retain the shared Redis contract.

The default `Cookie` session source preserves standalone gateway behavior. It reads the configurable `Realtime:SessionCookieName` and validates it through the same store.

Set `Realtime:AuthorizationPolicy` to attach a standard ASP.NET Core authorization policy to both mapped endpoints. Internal Origin, ticket, session, tenant, user, route, payload, timeout, queue, heartbeat, and close-code enforcement still applies.

`UseRealtimeGateway` installs forwarded-header and WebSocket middleware, so call it before authentication, authorization, session, and mapped endpoints. `MapRealtimeGateway` fails if called twice or if either configured route is already mapped.
