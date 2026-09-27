# Cormier.Realtime.HttpFallback

Optional HTTP fallback transport for hosts that already use `Cormier.Realtime.AspNetCore`. It preserves the same protocol envelopes, authentication, route authorization, Redis delivery, queue limits, and reconnect behavior while using bounded long-poll requests for server-to-client messages and HTTP POST for client commands. A streaming endpoint is also available to custom clients.

```csharp
builder.Services.AddRealtimeGateway(builder.Configuration);
builder.Services.AddRealtimeHttpFallback(builder.Configuration);

app.UseRealtimeGateway();
app.MapRealtimeGateway();
app.MapRealtimeHttpFallback();
```

Configure `HttpFallback:BasePath` explicitly when `/realtime/http` is not appropriate. `ConnectionTimeoutSeconds` bounds how long a newly created connection may wait for its first receiver, and `PollTimeoutSeconds` bounds each long-poll request. The browser SDK only uses these endpoints when `transports` includes `http-streaming`; installing this package does not change existing WebSocket clients.
