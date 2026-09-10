# Cormier.Realtime ASP.NET Core integration

`Cormier.Realtime.AspNetCore` adds the existing realtime gateway to an ASP.NET Core application without copying gateway infrastructure.

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
builder.Services.AddRealtimeGateway(builder.Configuration);
if (builder.Configuration.GetValue<bool>("Diagnostics:Enabled"))
{
    builder.Services.AddRealtimeDiagnosticsBearer(
        builder.Configuration["Diagnostics:AuthorizationPolicy"]!,
        builder.Configuration["Diagnostics:OperatorToken"]!);
}
if (!string.IsNullOrWhiteSpace(builder.Configuration["Metrics:AuthorizationPolicy"]))
{
    builder.Services.AddRealtimeMetricsBearer(
        builder.Configuration["Metrics:AuthorizationPolicy"]!,
        builder.Configuration["Metrics:ScrapeToken"]!);
}

var app = builder.Build();
app.UseRealtimeGateway();
app.UseAuthentication();
app.UseAuthorization();
app.UseSession();
app.MapRealtimeGateway();
app.MapRealtimeDiagnostics();
```

Configure the `Gateway`, `Redis`, `Proxy`, `Realtime`, `Metrics`, and `Diagnostics` sections. Network locations, routes, cookie names, origins, Redis keys, and deployment names remain configuration values.

`MapRealtimeDiagnostics` maps the configured Prometheus/OpenMetrics endpoint and, only when explicitly enabled, the operator diagnostics routes. Diagnostics require a registered authorization policy plus configured Origin and network restrictions; Production requires the additional `Diagnostics:ProductionEnabled` acknowledgement. `AddRealtimeDiagnosticsBearer` is the built-in option for a strong runtime-provided operator token, while `AddRealtimeMetricsBearer` registers a distinct scrape credential and scheme. Applications using an identity provider can instead register their own policies. Never reuse the diagnostics and metrics policies or tokens, or place credentials in source, appsettings, Helm values, or browser storage. The live log/event streams and temporary log-level controls are bounded, redacted, audited, time-limited, and replica-coordinated through Redis. See the repository diagnostics runbook for the full policy and rollback matrix.

For standard ASP.NET Core session middleware, call `AddSession` during service registration and place `UseSession` before the mapped endpoints execute. Set `Realtime:SessionSource` to `AspNetCoreSession`. The resolver reads `Cormier.Realtime.SessionId` from `HttpContext.Session`, falling back to `ISession.Id`, and validates that identifier through the existing `IRealtimeSessionStore`; expiration, revocation, tenant scope, and reconnect therefore retain the shared Redis contract.

The default `Cookie` session source preserves standalone gateway behavior. It reads the configurable `Realtime:SessionCookieName` and validates it through the same store.

Set `Realtime:AuthorizationPolicy` to attach a standard ASP.NET Core authorization policy to both mapped endpoints. Internal Origin, ticket, session, tenant, user, route, payload, timeout, queue, heartbeat, and close-code enforcement still applies.

`UseRealtimeGateway` installs forwarded-header and WebSocket middleware, so call it before authentication, authorization, session, and mapped endpoints. `MapRealtimeGateway` fails if called twice or if either configured route is already mapped.
