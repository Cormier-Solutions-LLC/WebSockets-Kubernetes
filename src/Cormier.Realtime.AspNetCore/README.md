# Cormier.Realtime ASP.NET Core integration

`Cormier.Realtime.AspNetCore` adds the existing realtime gateway to an ASP.NET Core application without copying gateway infrastructure.

The package targets `net10.0` and requires the ASP.NET Core shared framework. Add it to a .NET 10 web host from your approved NuGet source (`dotnet add package Cormier.Realtime.AspNetCore --version 1.0.0-beta`). It carries compatible Contracts and Redis dependencies; it does not launch a separate gateway process or provide a login/identity provider.

The following host setup assumes the required external configuration is already supplied. Memory-backed ASP.NET Core sessions are suitable only for a single-process example; choose a shared session store for multiple replicas.

```csharp
using Cormier.Realtime.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
builder.Services.AddAuthentication();
builder.Services.AddAuthorization();
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
app.Run();
```

Configure the `Gateway`, `Redis`, `Proxy`, `Realtime`, `Metrics`, and `Diagnostics` sections. Network locations, routes, cookie names, origins, Redis keys, and deployment names remain configuration values.

At minimum supply a reachable `Redis:Endpoint`, a nonempty `Redis:InstancePrefix`, and the intended `Realtime:AllowedOrigins`. Supply Redis user/password together from runtime secret configuration when authentication is enabled. `Proxy:TrustedNetworks` must describe only the trusted forwarding hop; the middleware forwarding limit is one. The default routes are GET `/realtime/ws` and POST `/realtime/tickets`, with cookie session resolution and the `cormier.realtime.v1` subprotocol. Register any application authorization policy before selecting it.

`MapRealtimeDiagnostics` maps the configured Prometheus/OpenMetrics endpoint and, only when explicitly enabled, the operator diagnostics routes. Diagnostics require a registered authorization policy plus configured Origin and network restrictions; Production requires the additional `Diagnostics:ProductionEnabled` acknowledgement. `AddRealtimeDiagnosticsBearer` is the built-in option for a strong runtime-provided operator token, while `AddRealtimeMetricsBearer` registers a distinct scrape credential and scheme. Applications using an identity provider can instead register their own policies. Never reuse the diagnostics and metrics policies or tokens, or place credentials in source, appsettings, Helm values, or browser storage. The live log/event streams and temporary log-level controls are bounded, redacted, audited, time-limited, and replica-coordinated through Redis. See the repository diagnostics runbook for the full policy and rollback matrix.

For standard ASP.NET Core session middleware, call `AddSession` during service registration and place `UseSession` before the mapped endpoints execute. Set `Realtime:SessionSource` to `AspNetCoreSession`. The resolver reads `Cormier.Realtime.SessionId` from `HttpContext.Session`, falling back to `ISession.Id`, and validates that identifier through the existing `IRealtimeSessionStore`; expiration, revocation, tenant scope, and reconnect therefore retain the shared Redis contract.

`AddSession` alone does not create an authorized realtime identity. The host's login flow must create the matching gateway session record (or provide an `IRealtimeSessionStore` implementation) and place its identifier in the configured session key. Cookie mode likewise requires an existing valid store record. Diagnostics bearer credentials are operator credentials, not application login credentials.

The default `Cookie` session source preserves standalone gateway behavior. It reads the configurable `Realtime:SessionCookieName` and validates it through the same store.

Set `Realtime:AuthorizationPolicy` to attach a standard ASP.NET Core authorization policy to both mapped endpoints. Internal Origin, ticket, session, tenant, user, route, payload, timeout, queue, heartbeat, and close-code enforcement still applies.

`UseRealtimeGateway` installs forwarded-header, response-compression, diagnostics preflight and WebSocket middleware, so call it before authentication, authorization, session, and mapped endpoints. `MapRealtimeGateway` fails if called twice or if an existing equivalent route accepts the same method. Health endpoints are owned by the host: the standalone gateway maps `/health/startup`, `/health/live` and `/health/ready` in its `Program.cs`; these are not added by `MapRealtimeGateway`.

`MapRealtimeDiagnostics` maps metrics only when `Metrics:Enabled` is true (the default); metrics are unprotected unless a policy/network restriction is configured. OTLP metric export is separately enabled by `Metrics:OtlpEnabled` and configured through standard OpenTelemetry exporter settings. See the [diagnostics runbook](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/runbooks/diagnostics.md), [protocol contract](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/protocol.md) and [package release policy](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/package-release.md).

Repository verification includes hosting integration tests and `scripts/Test-AspNetCorePackage.ps1` for an isolated packaged consumer. A successful package install does not validate deployment Redis, proxy trust, identity provisioning or operator authorization.
