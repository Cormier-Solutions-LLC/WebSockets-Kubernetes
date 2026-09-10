# .NET client example

This example uses the runtime-neutral `Cormier.Realtime.Client` package to connect, authenticate, subscribe, publish, receive, and stop cooperatively.

Supply the gateway endpoint and either a short-lived connection ticket or same-origin-compatible Cookie header through process configuration:

```powershell
$env:REALTIME_ENDPOINT = 'wss://gateway.example/realtime/ws'
$env:REALTIME_TICKET = '<short-lived-ticket>'
dotnet run --project ./examples/dotnet-client
```

The example never writes authentication values. Production applications should implement `IRealtimeAuthenticationProvider` against their own secure session or ticket source so every reconnect receives fresh material.
