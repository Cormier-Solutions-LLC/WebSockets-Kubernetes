using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

var options = LoadOptions.Parse(args);
using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(options.DurationSeconds + 60));
using var receivers = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
var errors = new ConcurrentBag<string>();
var connectionLatencies = new ConcurrentBag<double>();
var acknowledgementLatencies = new ConcurrentBag<double>();
var clients = new ConcurrentBag<ClientState>();
var fanoutPublished = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
var fanoutDeliveries = new ConcurrentDictionary<(int ClientIndex, string CorrelationId), byte>();
var fanoutLocks = new ConcurrentDictionary<string, object>(StringComparer.Ordinal);
var startedAt = DateTimeOffset.UtcNow;
var runTimer = Stopwatch.StartNew();
long sent = 0;
long received = 0;
long eventsReceived = 0;
long slowConsumerCloses = 0;

await Task.WhenAll(Enumerable.Range(0, options.Connections).Select(async index =>
{
    var socket = new ClientWebSocket();
    socket.Options.AddSubProtocol(options.SubProtocol);
    socket.Options.SetRequestHeader("Origin", options.Origin.AbsoluteUri.TrimEnd('/'));
    socket.Options.SetRequestHeader("Cookie", $"{options.SessionCookieName}={options.SessionId}");
    var timer = Stopwatch.StartNew();
    try
    {
        await socket.ConnectAsync(options.Endpoint, timeout.Token);
        connectionLatencies.Add(timer.Elapsed.TotalMilliseconds);
        clients.Add(new ClientState(index, socket));
    }
    catch (Exception exception) when (exception is WebSocketException or HttpRequestException or OperationCanceledException)
    {
        errors.Add($"connect:{exception.GetType().Name}");
        socket.Dispose();
    }
}));

var orderedClients = clients.OrderBy(client => client.Index).ToArray();
var receiveTasks = options.Scenario == "slow-client"
    ? Array.Empty<Task>()
    : orderedClients.Select(client => ReceiveAsync(client, receivers.Token)).ToArray();

if (options.Scenario is "fanout" or "slow-client")
{
    await Task.WhenAll(orderedClients.Select(async client =>
    {
        try
        {
            await SendCommandAsync(client, "subscribe", 0, awaitAcknowledgement: options.Scenario != "slow-client", timeout.Token);
        }
        catch (Exception exception)
        {
            errors.Add($"subscribe:{exception.GetType().Name}");
        }
    }));
}

var deadline = DateTimeOffset.UtcNow.AddSeconds(options.DurationSeconds);
if (options.Scenario == "connection")
{
    var connectionDeadline = DateTimeOffset.UtcNow.AddSeconds(options.DurationSeconds);
    await Task.WhenAll(orderedClients.Select(async client =>
    {
        try
        {
            while (DateTimeOffset.UtcNow < connectionDeadline)
            {
                await SendCommandAsync(client, "ping", 0, awaitAcknowledgement: true, timeout.Token);
                var remaining = connectionDeadline - DateTimeOffset.UtcNow;
                if (remaining > TimeSpan.Zero) await Task.Delay(remaining < TimeSpan.FromSeconds(10) ? remaining : TimeSpan.FromSeconds(10), timeout.Token);
            }
        }
        catch (Exception exception)
        {
            errors.Add($"connection:{exception.GetType().Name}");
        }
    }));
}
else
{
    await Task.WhenAll(orderedClients.Select(async client =>
    {
        var message = 0;
        while (options.Scenario == "soak"
            ? DateTimeOffset.UtcNow < deadline
            : message < options.MessagesPerConnection)
        {
            try
            {
                await SendCommandAsync(client, "publish", options.PayloadBytes, options.Scenario != "slow-client", timeout.Token);
                Interlocked.Increment(ref sent);
                if (options.Scenario == "soak") await Task.Delay(TimeSpan.FromMilliseconds(100), timeout.Token);
                message++;
            }
            catch (OperationCanceledException) when (
                options.Scenario == "soak" && DateTimeOffset.UtcNow >= deadline)
            {
                break;
            }
            catch (Exception) when (options.Scenario == "slow-client")
            {
                // The server may stop accepting sends after initiating the expected slow-consumer close.
                break;
            }
            catch (Exception exception)
            {
                errors.Add($"send:{exception.GetType().Name}");
                break;
            }
        }
    }));

    if (options.Scenario == "slow-client")
    {
        var remaining = deadline - DateTimeOffset.UtcNow;
        try
        {
            if (remaining > TimeSpan.Zero) await Task.Delay(remaining, timeout.Token);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            errors.Add("slow-client:deadline-expired");
        }
        await Task.WhenAll(orderedClients.Select(ValidateSlowConsumerCloseAsync));
    }
    else if (options.Scenario == "fanout")
    {
        var expectedEvents = Interlocked.Read(ref sent) * orderedClients.Length;
        try
        {
            while (Interlocked.Read(ref eventsReceived) < expectedEvents && DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(25), timeout.Token);
            }
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            errors.Add("fanout:deadline-expired");
        }

        var deliveredEvents = Interlocked.Read(ref eventsReceived);
        if (deliveredEvents < expectedEvents) errors.Add($"fanout:incomplete-delivery:{deliveredEvents}/{expectedEvents}");
    }
}

foreach (var client in orderedClients)
{
    try
    {
        if (client.Socket.State == WebSocketState.Open)
        {
            await client.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "load_complete", CancellationToken.None);
        }
    }
    catch (Exception exception) when (exception is WebSocketException or IOException)
    {
        errors.Add($"close:{exception.GetType().Name}");
    }
}

receivers.Cancel();
try { await Task.WhenAll(receiveTasks); }
catch (OperationCanceledException) when (receivers.IsCancellationRequested) { }
foreach (var client in orderedClients) client.Socket.Dispose();
runTimer.Stop();

var result = new
{
    schemaVersion = 2,
    scenario = options.Scenario,
    startedAt,
    durationSeconds = Math.Round(runTimer.Elapsed.TotalSeconds, 3),
    requestedConnections = options.Connections,
    establishedConnections = orderedClients.Length,
    messagesSent = Interlocked.Read(ref sent),
    messagesReceived = Interlocked.Read(ref received),
    eventMessagesReceived = Interlocked.Read(ref eventsReceived),
    verifiedSlowConsumerCloses = Interlocked.Read(ref slowConsumerCloses),
    payloadBytes = options.PayloadBytes,
    operationsPerSecond = runTimer.Elapsed.TotalSeconds > 0 ? Math.Round(Interlocked.Read(ref sent) / runTimer.Elapsed.TotalSeconds, 3) : 0,
    connectionLatencyMilliseconds = Percentiles(connectionLatencies),
    acknowledgedMessageLatencyMilliseconds = Percentiles(acknowledgementLatencies),
    errorCount = errors.Count,
    errors = errors.GroupBy(error => error).Select(group => new { error = group.Key, count = group.Count() }).OrderBy(item => item.error).ToArray(),
};
var outputPath = Path.GetFullPath(options.OutputPath);
Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
await File.WriteAllTextAsync(outputPath, json, CancellationToken.None);
Console.WriteLine(json);
return errors.IsEmpty ? 0 : 1;

async Task SendCommandAsync(ClientState client, string type, int payloadBytes, bool awaitAcknowledgement, CancellationToken cancellationToken)
{
    var correlationId = Guid.NewGuid().ToString("N");
    var trackFanout = options.Scenario == "fanout" && type == "publish";
    if (trackFanout)
    {
        fanoutLocks.TryAdd(correlationId, new object());
        fanoutPublished.TryAdd(correlationId, 0);
    }
    TaskCompletionSource<double>? acknowledgement = null;
    if (awaitAcknowledgement)
    {
        acknowledgement = new(TaskCreationOptions.RunContinuationsAsynchronously);
        client.Pending[correlationId] = new PendingRequest(Stopwatch.GetTimestamp(), acknowledgement);
    }

    var envelope = JsonSerializer.Serialize(new
    {
        version = "1.0",
        type,
        correlationId,
        timestamp = DateTimeOffset.UtcNow,
        route = $"topics/{options.Topic}",
        payload = new { data = new string('x', payloadBytes) },
    });
    var bytes = Encoding.UTF8.GetBytes(envelope);
    try
    {
        await client.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
        if (acknowledgement is not null)
        {
            var latency = await acknowledgement.Task.WaitAsync(cancellationToken);
            if (type == "publish") acknowledgementLatencies.Add(latency);
        }
    }
    catch
    {
        client.Pending.TryRemove(correlationId, out _);
        if (trackFanout && fanoutLocks.TryGetValue(correlationId, out var fanoutLock))
        {
            lock (fanoutLock)
            {
                fanoutPublished.TryRemove(correlationId, out _);
                foreach (var delivery in fanoutDeliveries.Keys.Where(key => key.CorrelationId == correlationId))
                {
                    if (fanoutDeliveries.TryRemove(delivery, out _)) Interlocked.Decrement(ref eventsReceived);
                }
            }
        }
        throw;
    }
}

async Task ReceiveAsync(ClientState client, CancellationToken cancellationToken)
{
    var buffer = new byte[131072];
    while (!cancellationToken.IsCancellationRequested && client.Socket.State is WebSocketState.Open or WebSocketState.CloseSent)
    {
        try
        {
            var result = await client.Socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                FailPending(client, new IOException("The server closed the WebSocket."));
                return;
            }
            if (!result.EndOfMessage) throw new InvalidDataException("The load runner requires unfragmented server messages.");
            Interlocked.Increment(ref received);
            using var document = JsonDocument.Parse(buffer.AsMemory(0, result.Count));
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type)) continue;
            if (type.GetString() == "event")
            {
                if (options.Scenario != "fanout")
                {
                    Interlocked.Increment(ref eventsReceived);
                }
                else if (root.TryGetProperty("correlationId", out var eventCorrelation))
                {
                    var correlationId = eventCorrelation.GetString() ?? string.Empty;
                    if (fanoutLocks.TryGetValue(correlationId, out var fanoutLock))
                    {
                        lock (fanoutLock)
                        {
                            if (fanoutPublished.ContainsKey(correlationId) &&
                                fanoutDeliveries.TryAdd((client.Index, correlationId), 0))
                            {
                                Interlocked.Increment(ref eventsReceived);
                            }
                        }
                    }
                }
            }
            if (type.GetString() == "error" &&
                root.TryGetProperty("correlationId", out var errorCorrelation) &&
                client.Pending.TryRemove(errorCorrelation.GetString() ?? string.Empty, out var failedPending))
            {
                failedPending.Completion.TrySetException(new InvalidDataException("The gateway rejected the correlated command."));
            }
            if (type.GetString() == "ack" &&
                root.TryGetProperty("correlationId", out var correlation) &&
                client.Pending.TryRemove(correlation.GetString() ?? string.Empty, out var pending))
            {
                pending.Completion.TrySetResult(Stopwatch.GetElapsedTime(pending.Started).TotalMilliseconds);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
        catch (Exception exception) when (exception is WebSocketException or IOException or JsonException)
        {
            if (!cancellationToken.IsCancellationRequested) errors.Add($"receive:{exception.GetType().Name}");
            FailPending(client, exception);
            return;
        }
    }
}

async Task ValidateSlowConsumerCloseAsync(ClientState client)
{
    const int expectedCloseCode = 4008;
    if ((int?)client.Socket.CloseStatus == expectedCloseCode)
    {
        Interlocked.Increment(ref slowConsumerCloses);
        return;
    }

    using var closeTimeout = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
    closeTimeout.CancelAfter(TimeSpan.FromSeconds(10));
    var buffer = new byte[131072];
    try
    {
        while (client.Socket.State is WebSocketState.Open or WebSocketState.CloseSent or WebSocketState.CloseReceived)
        {
            var result = await client.Socket.ReceiveAsync(buffer, closeTimeout.Token);
            if (result.MessageType != WebSocketMessageType.Close) continue;
            if ((int?)client.Socket.CloseStatus == expectedCloseCode)
            {
                Interlocked.Increment(ref slowConsumerCloses);
            }
            else
            {
                errors.Add($"slow-client:unexpected-close:{(int?)client.Socket.CloseStatus ?? 0}");
            }
            return;
        }
    }
    catch (OperationCanceledException) when (closeTimeout.IsCancellationRequested)
    {
        errors.Add("slow-client:close-timeout");
        return;
    }
    catch (WebSocketException)
    {
        if ((int?)client.Socket.CloseStatus == expectedCloseCode)
        {
            Interlocked.Increment(ref slowConsumerCloses);
            return;
        }
    }

    errors.Add($"slow-client:missing-close:{(int?)client.Socket.CloseStatus ?? 0}");
}

static void FailPending(ClientState client, Exception exception)
{
    foreach (var correlationId in client.Pending.Keys)
    {
        if (client.Pending.TryRemove(correlationId, out var pending)) pending.Completion.TrySetException(exception);
    }
}

static object Percentiles(IEnumerable<double> samples)
{
    var ordered = samples.Order().ToArray();
    double Value(double percentile) => ordered.Length == 0 ? 0 : Math.Round(ordered[Math.Max(0, (int)Math.Ceiling(percentile * ordered.Length) - 1)], 3);
    return new { count = ordered.Length, p50 = Value(0.50), p95 = Value(0.95), p99 = Value(0.99), maximum = Value(1) };
}

internal sealed record PendingRequest(long Started, TaskCompletionSource<double> Completion);

internal sealed record ClientState(int Index, ClientWebSocket Socket)
{
    public ConcurrentDictionary<string, PendingRequest> Pending { get; } = new(StringComparer.Ordinal);
}

internal sealed record LoadOptions(Uri Endpoint, Uri Origin, string SessionId, string SessionCookieName, string SubProtocol, string Topic, int Connections, int MessagesPerConnection, int PayloadBytes, string Scenario, int DurationSeconds, string OutputPath)
{
    public static LoadOptions Parse(string[] args)
    {
        var values = args.Chunk(2).ToDictionary(pair => pair[0], pair => pair.Length == 2 ? pair[1] : string.Empty, StringComparer.Ordinal);
        string Required(string name) => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException($"{name} is required.");
        int Number(string name) => int.Parse(Required(name), System.Globalization.CultureInfo.InvariantCulture);
        var endpoint = new Uri(Required("--endpoint"), UriKind.Absolute);
        var origin = new Uri(Required("--origin"), UriKind.Absolute);
        if (endpoint.Scheme is not ("ws" or "wss")) throw new ArgumentException("--endpoint must use ws or wss.");
        if (origin.Scheme is not ("http" or "https")) throw new ArgumentException("--origin must use http or https.");
        var scenario = Required("--scenario");
        if (scenario is not ("connection" or "fanout" or "burst" or "large-message" or "slow-client" or "soak")) throw new ArgumentException("Unsupported scenario.");
        var sessionId = Environment.GetEnvironmentVariable("CORMIER_LOAD_SESSION_ID");
        if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("CORMIER_LOAD_SESSION_ID is required.");
        return new(endpoint, origin, sessionId, Required("--session-cookie-name"), Required("--subprotocol"), Required("--topic"), Number("--connections"), Number("--messages-per-connection"), Number("--payload-bytes"), scenario, Number("--duration-seconds"), Required("--output"));
    }
}
