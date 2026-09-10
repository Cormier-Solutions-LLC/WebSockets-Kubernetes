using System.Text.Json;
using System.Threading.Channels;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.Client;

public sealed class RealtimeClient : IDisposable
{
    private const int ConnectingEventId = 1000;
    private const int ConnectedEventId = 1001;
    private const int ReconnectingEventId = 1002;
    private const int DisconnectedEventId = 1003;
    private const int ProtocolFailureEventId = 1004;
    private const int CloseFailureEventId = 1005;
    private const int ConsumerCallbackFailureEventId = 1006;
    private static readonly JsonElement NullPayload = JsonSerializer.Deserialize<JsonElement>("null");
    private readonly RealtimeClientOptions _options;
    private readonly IRealtimeAuthenticationProvider _authenticationProvider;
    private readonly IRealtimeTransportFactory _transportFactory;
    private readonly IRealtimeClientLogger _logger;
    private readonly IRealtimeClientClock _clock;
    private readonly IRealtimeRetryPolicy _retryPolicy;
    private readonly Channel<MessageEnvelope> _outbound;
    private readonly Channel<bool> _sendSlots;
    private readonly Channel<ServerMessageEnvelope> _inbound;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TaskCompletionSource<bool> _firstConnection = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _stateLock = new();
    private readonly SemaphoreSlim _subscriptionOrderGate = new(1, 1);
    private readonly SemaphoreSlim _subscriptionGate = new(1, 1);
    private readonly HashSet<string> _subscriptions = new(StringComparer.Ordinal);
    private readonly HashSet<string> _heartbeatCorrelations = new(StringComparer.Ordinal);
    private readonly Queue<MessageEnvelope> _replayBacklog = new();
    private Task _stateNotificationTask = Task.CompletedTask;
    private Task? _runTask;
    private RealtimeClientState _state;
    private bool _acceptingSends = true;
    private bool _disposed;

    public RealtimeClient(
        RealtimeClientOptions options,
        IRealtimeAuthenticationProvider? authenticationProvider = null,
        IRealtimeTransportFactory? transportFactory = null,
        IRealtimeClientLogger? logger = null,
        IRealtimeClientClock? clock = null,
        IRealtimeRetryPolicy? retryPolicy = null)
    {
        if (options is null)
        {
            throw new ArgumentNullException(nameof(options));
        }
        options.Validate();
        _options = options.Snapshot();
        _authenticationProvider = authenticationProvider ?? AnonymousRealtimeAuthenticationProvider.Instance;
        _transportFactory = transportFactory ?? new ClientWebSocketTransportFactory();
        _logger = logger ?? NullRealtimeClientLogger.Instance;
        _clock = clock ?? SystemRealtimeClientClock.Instance;
        _retryPolicy = retryPolicy ?? new ExponentialRealtimeRetryPolicy(_options);
        _outbound = Channel.CreateUnbounded<MessageEnvelope>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });
        _sendSlots = Channel.CreateBounded<bool>(new BoundedChannelOptions(_options.SendQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false,
        });
        for (var index = 0; index < _options.SendQueueCapacity; index++)
        {
            _sendSlots.Writer.TryWrite(true);
        }
        _inbound = Channel.CreateBounded<ServerMessageEnvelope>(new BoundedChannelOptions(_options.ReceiveQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = true,
        });
    }

    public event EventHandler<RealtimeClientStateChangedEventArgs>? StateChanged;

    public RealtimeClientState State
    {
        get
        {
            lock (_stateLock)
            {
                return _state;
            }
        }
    }

    public async Task ConnectAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        CancellationTokenRegistration connectCancellation = default;
        lock (_stateLock)
        {
            if (_runTask is { IsCompleted: true } && _state != RealtimeClientState.Connected)
            {
                throw new InvalidOperationException(
                    "A completed realtime client cannot be restarted. Create a new client instance.");
            }
            if (_runTask is not null &&
                _state is not RealtimeClientState.Connecting and not RealtimeClientState.Connected)
            {
                throw new InvalidOperationException(
                    "ConnectAsync cannot be used while the realtime client is reconnecting or stopping.");
            }
            if (_runTask is null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (cancellationToken.CanBeCanceled)
                {
                    connectCancellation = cancellationToken.Register(() => _lifetime.Cancel());
                }
                _runTask = RunAsync(_lifetime.Token);
            }
        }
        using (connectCancellation)
        {
            await AwaitWithCancellationAsync(_firstConnection.Task, cancellationToken).ConfigureAwait(false);
        }
    }

    public Task SendAsync(MessageEnvelope message, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (message is not null &&
            (string.Equals(message.Type, ProtocolMessageTypes.Subscribe, StringComparison.Ordinal) ||
             string.Equals(message.Type, ProtocolMessageTypes.Unsubscribe, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException(
                "Use SubscribeAsync and UnsubscribeAsync so reconnect state remains consistent.");
        }
        return SendCoreAsync(message!, cancellationToken);
    }

    private async Task SendCoreAsync(MessageEnvelope message, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        var ownedMessage = PrepareOwnedMessage(message);
        await EnqueueOwnedAsync(ownedMessage, cancellationToken).ConfigureAwait(false);
    }

    private MessageEnvelope PrepareOwnedMessage(MessageEnvelope message)
    {
        var validation = ProtocolValidator.Validate(message, _clock.UtcNow);
        if (!validation.IsValid)
        {
            throw new RealtimeProtocolException("The outbound protocol message is invalid.");
        }
        var ownedPayload = message.Payload.ValueKind == JsonValueKind.Undefined
            ? NullPayload
            : message.Payload;
        var ownedMessage = new MessageEnvelope(
            message.Version,
            message.Type,
            message.CorrelationId,
            message.Timestamp,
            message.Route,
            ownedPayload.Clone());
        var encoded = JsonSerializer.SerializeToUtf8Bytes(
            ownedMessage,
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        if (encoded.Length > _options.MaximumFrameBytes)
        {
            throw new RealtimeProtocolException("The outbound protocol message exceeded the configured frame limit.");
        }
        return ownedMessage;
    }

    public Task PublishAsync(
        string route,
        JsonElement payload,
        string? correlationId = null,
        CancellationToken cancellationToken = default) =>
        SendAsync(CreateMessage(ProtocolMessageTypes.Publish, route, payload, correlationId), cancellationToken);

    public Task PublishAsync(
        RealtimeRoute route,
        JsonElement payload,
        string? correlationId = null,
        CancellationToken cancellationToken = default) =>
        PublishAsync(route.Value, payload, correlationId, cancellationToken);

    public async Task SubscribeAsync(
        string route,
        string? correlationId = null,
        CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await _subscriptionOrderGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await ChangeSubscriptionAsync(route, correlationId, subscribe: true, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _subscriptionOrderGate.Release();
        }
    }

    public Task SubscribeAsync(
        RealtimeRoute route,
        string? correlationId = null,
        CancellationToken cancellationToken = default) =>
        SubscribeAsync(route.Value, correlationId, cancellationToken);

    public async Task UnsubscribeAsync(
        string route,
        string? correlationId = null,
        CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await _subscriptionOrderGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await ChangeSubscriptionAsync(route, correlationId, subscribe: false, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _subscriptionOrderGate.Release();
        }
    }

    public Task UnsubscribeAsync(
        RealtimeRoute route,
        string? correlationId = null,
        CancellationToken cancellationToken = default) =>
        UnsubscribeAsync(route.Value, correlationId, cancellationToken);

    private async Task ChangeSubscriptionAsync(
        string route,
        string? correlationId,
        bool subscribe,
        CancellationToken cancellationToken)
    {
        await _sendSlots.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        var sendSlotTransferred = false;
        try
        {
            await _subscriptionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                ThrowIfDisposed();
                EnsureConnectedForSubscriptionChange();
                lock (_subscriptions)
                {
                    if (subscribe)
                    {
                        if (_subscriptions.Contains(route))
                        {
                            return;
                        }
                        if (_subscriptions.Count >= _options.MaximumSubscriptions)
                        {
                            throw new RealtimeClientException("The configured subscription limit has been reached.");
                        }
                        _subscriptions.Add(route);
                    }
                    else if (!_subscriptions.Remove(route))
                    {
                        return;
                    }
                }

                try
                {
                    var message = PrepareOwnedMessage(CreateMessage(
                        subscribe ? ProtocolMessageTypes.Subscribe : ProtocolMessageTypes.Unsubscribe,
                        route,
                        NullPayload,
                        correlationId));
                    sendSlotTransferred = true;
                    await EnqueueOwnedAsync(message, cancellationToken, acquireSendSlot: false)
                        .ConfigureAwait(false);
                }
                catch
                {
                    lock (_subscriptions)
                    {
                        if (subscribe)
                        {
                            _subscriptions.Remove(route);
                        }
                        else
                        {
                            _subscriptions.Add(route);
                        }
                    }
                    throw;
                }
            }
            finally
            {
                _subscriptionGate.Release();
            }
        }
        finally
        {
            if (!sendSlotTransferred)
            {
                ReleaseSendSlot();
            }
        }
    }

    public async Task<ServerMessageEnvelope> ReceiveAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        return await _inbound.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken = default)
    {
        Task? runTask;
        var completeWithoutRun = false;
        lock (_stateLock)
        {
            if (_disposed)
            {
                return;
            }
            _acceptingSends = false;
            runTask = _runTask;
            if (runTask is null)
            {
                _runTask = Task.CompletedTask;
                completeWithoutRun = true;
            }
            else if (runTask.IsCompleted || _state is RealtimeClientState.Disconnected or RealtimeClientState.Faulted)
            {
                return;
            }
            else
            {
                QueueStateChangeLocked(RealtimeClientState.Stopping);
            }
        }
        _lifetime.Cancel();
        if (completeWithoutRun)
        {
            CompleteChannels();
            return;
        }
        await AwaitWithCancellationAsync(runTask!, cancellationToken).ConfigureAwait(false);
    }

    public void Dispose()
    {
        Task? runTask;
        var completeWithoutRun = false;
        lock (_stateLock)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _acceptingSends = false;
            runTask = _runTask;
            if (runTask is null)
            {
                _runTask = Task.CompletedTask;
                completeWithoutRun = true;
            }
        }
        _lifetime.Cancel();
        if (completeWithoutRun)
        {
            CompleteChannels();
        }
        try
        {
            runTask?.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            // Cancellation is the expected completion path during synchronous disposal.
        }
        _lifetime.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var reconnectAttempt = 0;
        RealtimeTransportClose? retryContext = null;
        while (!cancellationToken.IsCancellationRequested)
        {
            RealtimeTransportClose? close = null;
            IRealtimeTransport? transport = null;
            var cleanupCloseCode = RealtimeCloseCodes.Normal;
            var cleanupCloseReason = "client_disconnect";
            try
            {
                SetState(reconnectAttempt == 0 ? RealtimeClientState.Connecting : RealtimeClientState.Reconnecting);
                Log(
                    RealtimeClientLogLevel.Information,
                    reconnectAttempt == 0 ? ConnectingEventId : ReconnectingEventId,
                    reconnectAttempt == 0 ? "Realtime connection is starting." : "Realtime connection retry is starting.");
                var authentication = await _authenticationProvider.GetAuthenticationAsync(cancellationToken)
                    .ConfigureAwait(false);
                transport = await _transportFactory.ConnectAsync(
                    _options.Endpoint!,
                    authentication,
                    _options.SubProtocol,
                    _options.MaximumFrameBytes,
                    _options.MaximumMessageBytes,
                    cancellationToken).ConfigureAwait(false);
                await ReplayConnectionStateAsync(transport, cancellationToken).ConfigureAwait(false);
                retryContext = null;
                SetState(RealtimeClientState.Connected);
                reconnectAttempt = 0;
                _firstConnection.TrySetResult(true);
                Log(RealtimeClientLogLevel.Information, ConnectedEventId, "Realtime connection is established.");

                using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var send = SendLoopAsync(transport, connectionCancellation.Token);
                var receive = ReceiveLoopAsync(transport, connectionCancellation.Token);
                var heartbeat = HeartbeatLoopAsync(connectionCancellation.Token);
                var completed = await Task.WhenAny(send, receive, heartbeat).ConfigureAwait(false);
                try
                {
                    close = completed == receive ? await receive.ConfigureAwait(false) : null;
                    if (completed != receive)
                    {
                        await completed.ConfigureAwait(false);
                    }
                }
                finally
                {
                    connectionCancellation.Cancel();
                    await ObserveSiblingLoopAsync(send, completed).ConfigureAwait(false);
                    await ObserveSiblingLoopAsync(receive, completed).ConfigureAwait(false);
                    await ObserveSiblingLoopAsync(heartbeat, completed).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (RealtimeProtocolException exception)
            {
                StopAcceptingSends();
                cleanupCloseCode = exception.CloseCode;
                cleanupCloseReason = "protocol_failure";
                Log(RealtimeClientLogLevel.Error, ProtocolFailureEventId, "Realtime protocol validation failed.");
                SetState(RealtimeClientState.Faulted);
                _firstConnection.TrySetException(new RealtimeProtocolException("Realtime protocol validation failed."));
                break;
            }
            catch (Exception)
            {
                if (reconnectAttempt >= _options.MaximumReconnectAttempts)
                {
                    StopAcceptingSends();
                    SetState(RealtimeClientState.Faulted);
                    _firstConnection.TrySetException(new RealtimeClientException(
                        "The realtime connection could not be established within the retry limit."));
                    break;
                }
                SetState(RealtimeClientState.Reconnecting);
            }
            finally
            {
                if (transport is not null)
                {
                    try
                    {
                        using var closeTimeout = new CancellationTokenSource(
                            TimeSpan.FromSeconds(_options.CloseTimeoutSeconds));
                        await transport.CloseAsync(
                            cleanupCloseCode,
                            cleanupCloseReason,
                            closeTimeout.Token).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        Log(
                            RealtimeClientLogLevel.Warning,
                            CloseFailureEventId,
                            "Realtime transport close failed during cleanup.");
                    }
                    transport.Dispose();
                }
            }

            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            if (close?.Code == RealtimeCloseCodes.Normal)
            {
                break;
            }
            if (close is not null)
            {
                retryContext = close;
            }
            if (close?.Code == RealtimeCloseCodes.AuthenticationExpired)
            {
                reconnectAttempt = Math.Max(reconnectAttempt, 0);
            }
            reconnectAttempt++;
            if (reconnectAttempt > _options.MaximumReconnectAttempts)
            {
                StopAcceptingSends();
                SetState(RealtimeClientState.Faulted);
                _firstConnection.TrySetException(new RealtimeClientException(
                    "The realtime connection closed after the configured retry limit."));
                break;
            }
            SetState(RealtimeClientState.Reconnecting);
            try
            {
                var delay = ReconnectDelay(reconnectAttempt, retryContext);
                await _clock.DelayAsync(delay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception)
            {
                StopAcceptingSends();
                SetState(RealtimeClientState.Faulted);
                _firstConnection.TrySetException(new RealtimeClientException(
                    "The realtime retry schedule failed."));
                break;
            }
        }

        CompleteChannels();
        if (State != RealtimeClientState.Faulted)
        {
            SetState(RealtimeClientState.Disconnected);
        }
        _firstConnection.TrySetCanceled(CancellationToken.None);
        Log(RealtimeClientLogLevel.Information, DisconnectedEventId, "Realtime connection is stopped.");
    }

    private async Task SendLoopAsync(IRealtimeTransport transport, CancellationToken cancellationToken)
    {
        while (await _outbound.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
        {
            while (_outbound.Reader.TryRead(out var message))
            {
                var refreshedMessage = RefreshTimestamp(message);
                try
                {
                    await SendDirectAsync(transport, refreshedMessage, cancellationToken).ConfigureAwait(false);
                    ReleaseSendSlot();
                }
                catch
                {
                    lock (_replayBacklog)
                    {
                        _replayBacklog.Enqueue(refreshedMessage);
                    }
                    throw;
                }
            }
        }
    }

    private async Task<RealtimeTransportClose?> ReceiveLoopAsync(
        IRealtimeTransport transport,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var received = await transport.ReceiveAsync(cancellationToken).ConfigureAwait(false);
            if (received.Close is not null)
            {
                if (received.Close.Code == RealtimeCloseCodes.Normal)
                {
                    BeginStopping();
                }
                else
                {
                    SetState(RealtimeClientState.Reconnecting);
                }
                return received.Close;
            }
            if (received.Payload is null)
            {
                throw new RealtimeProtocolException("The server returned an empty transport message.");
            }

            ServerMessageEnvelope? envelope;
            try
            {
                envelope = JsonSerializer.Deserialize(
                    received.Payload,
                    RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);
            }
            catch (JsonException)
            {
                throw new RealtimeProtocolException("The server returned malformed protocol JSON.");
            }
            var validation = ProtocolValidator.Validate(envelope);
            if (!validation.IsValid)
            {
                throw new RealtimeProtocolException("The server returned an invalid protocol envelope.");
            }

            if (string.Equals(envelope!.Type, ProtocolMessageTypes.ServiceRestart, StringComparison.Ordinal))
            {
                SetState(RealtimeClientState.Reconnecting);
                return new RealtimeTransportClose(
                    RealtimeCloseCodes.ServiceRestart,
                    "service_restart",
                    Clean: true,
                    envelope.Reconnect);
            }
            if (string.Equals(envelope.Type, ProtocolMessageTypes.Ping, StringComparison.Ordinal) ||
                IsAutomaticHeartbeatAcknowledgement(envelope))
            {
                continue;
            }
            await _inbound.Writer.WriteAsync(envelope, cancellationToken).ConfigureAwait(false);
        }
        return null;
    }

    private async Task HeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await _clock.DelayAsync(TimeSpan.FromSeconds(_options.HeartbeatSeconds), cancellationToken)
                .ConfigureAwait(false);
            var heartbeat = CreateMessage(ProtocolMessageTypes.Ping, "system/heartbeat", NullPayload, null);
            lock (_heartbeatCorrelations)
            {
                _heartbeatCorrelations.Add(heartbeat.CorrelationId);
            }
            try
            {
                await EnqueueOwnedAsync(heartbeat, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                lock (_heartbeatCorrelations)
                {
                    _heartbeatCorrelations.Remove(heartbeat.CorrelationId);
                }
                throw;
            }
        }
    }

    private async Task ReplayConnectionStateAsync(
        IRealtimeTransport transport,
        CancellationToken cancellationToken)
    {
        await _subscriptionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var pending = DrainPendingApplicationMessages();
            string[] routes;
            lock (_subscriptions)
            {
                routes = _subscriptions.OrderBy(route => route, StringComparer.Ordinal).ToArray();
            }
            foreach (var route in routes)
            {
                await SendDirectAsync(
                    transport,
                    CreateMessage(ProtocolMessageTypes.Subscribe, route, NullPayload, null),
                    cancellationToken).ConfigureAwait(false);
            }
            await ReplayPendingApplicationMessagesAsync(transport, pending, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _subscriptionGate.Release();
        }
    }

    private List<MessageEnvelope> DrainPendingApplicationMessages()
    {
        var pending = new List<MessageEnvelope>();
        lock (_replayBacklog)
        {
            while (_replayBacklog.Count > 0)
            {
                AddPendingApplicationMessage(pending, _replayBacklog.Dequeue());
            }
        }
        while (_outbound.Reader.TryRead(out var message))
        {
            AddPendingApplicationMessage(pending, message);
        }
        lock (_heartbeatCorrelations)
        {
            _heartbeatCorrelations.Clear();
        }
        return pending;
    }

    private void AddPendingApplicationMessage(List<MessageEnvelope> pending, MessageEnvelope message)
    {
        if (IsSubscriptionCommand(message) || IsAutomaticHeartbeat(message))
        {
            ReleaseSendSlot();
            return;
        }
        pending.Add(RefreshTimestamp(message));
    }

    private static bool IsSubscriptionCommand(MessageEnvelope message) =>
        string.Equals(message.Type, ProtocolMessageTypes.Subscribe, StringComparison.Ordinal) ||
        string.Equals(message.Type, ProtocolMessageTypes.Unsubscribe, StringComparison.Ordinal);

    private bool IsAutomaticHeartbeat(MessageEnvelope message)
    {
        lock (_heartbeatCorrelations)
        {
            return _heartbeatCorrelations.Remove(message.CorrelationId);
        }
    }

    private bool IsAutomaticHeartbeatAcknowledgement(ServerMessageEnvelope message)
    {
        if (!string.Equals(message.Type, ProtocolMessageTypes.Acknowledge, StringComparison.Ordinal))
        {
            return false;
        }
        lock (_heartbeatCorrelations)
        {
            return _heartbeatCorrelations.Remove(message.CorrelationId);
        }
    }

    private async Task ReplayPendingApplicationMessagesAsync(
        IRealtimeTransport transport,
        List<MessageEnvelope> pending,
        CancellationToken cancellationToken)
    {
        for (var index = 0; index < pending.Count; index++)
        {
            try
            {
                await SendDirectAsync(transport, pending[index], cancellationToken).ConfigureAwait(false);
                ReleaseSendSlot();
            }
            catch
            {
                lock (_replayBacklog)
                {
                    for (var unsent = index; unsent < pending.Count; unsent++)
                    {
                        _replayBacklog.Enqueue(pending[unsent]);
                    }
                }
                throw;
            }
        }
    }

    private MessageEnvelope RefreshTimestamp(MessageEnvelope message) =>
        new(
            message.Version,
            message.Type,
            message.CorrelationId,
            _clock.UtcNow,
            message.Route,
            message.Payload);

    private async Task EnqueueOwnedAsync(
        MessageEnvelope message,
        CancellationToken cancellationToken,
        bool acquireSendSlot = true)
    {
        if (acquireSendSlot)
        {
            await _sendSlots.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        }
        var accepted = false;
        lock (_stateLock)
        {
            if (_acceptingSends)
            {
                accepted = _outbound.Writer.TryWrite(message);
            }
        }
        if (!accepted)
        {
            ReleaseSendSlot();
            throw new ChannelClosedException();
        }
    }

    private void ReleaseSendSlot() => _sendSlots.Writer.TryWrite(true);

    private static Task SendDirectAsync(
        IRealtimeTransport transport,
        MessageEnvelope message,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(
            message,
            RealtimeJsonSerializerContext.Default.MessageEnvelope);
        return transport.SendAsync(payload, cancellationToken);
    }

    private MessageEnvelope CreateMessage(
        string type,
        string route,
        JsonElement payload,
        string? correlationId) =>
        new(
            ProtocolVersions.Current,
            type,
            string.IsNullOrWhiteSpace(correlationId) ? Guid.NewGuid().ToString("N") : correlationId!,
            _clock.UtcNow,
            route,
            payload);

    private TimeSpan ReconnectDelay(int attempt, RealtimeTransportClose? close)
        => _retryPolicy.GetDelay(attempt, close);

    private void SetState(RealtimeClientState state)
    {
        lock (_stateLock)
        {
            QueueStateChangeLocked(state);
        }
    }

    private void StopAcceptingSends()
    {
        lock (_stateLock)
        {
            _acceptingSends = false;
        }
    }

    private void BeginStopping()
    {
        lock (_stateLock)
        {
            _acceptingSends = false;
            QueueStateChangeLocked(RealtimeClientState.Stopping);
        }
    }

    private void QueueStateChangeLocked(RealtimeClientState state)
    {
        var previous = _state;
        if (previous == state)
        {
            return;
        }
        _state = state;
        _stateNotificationTask = _stateNotificationTask.ContinueWith(
            _ => RaiseStateChanged(previous, state),
            CancellationToken.None,
            TaskContinuationOptions.None,
            TaskScheduler.Default);
    }

    private void CompleteChannels()
    {
        lock (_stateLock)
        {
            _acceptingSends = false;
            _outbound.Writer.TryComplete();
            _sendSlots.Writer.TryComplete();
            _inbound.Writer.TryComplete();
            _firstConnection.TrySetCanceled(CancellationToken.None);
        }
    }

    private void RaiseStateChanged(RealtimeClientState previous, RealtimeClientState current)
    {
        var handlers = StateChanged;
        if (handlers is null)
        {
            return;
        }
        var eventArgs = new RealtimeClientStateChangedEventArgs(previous, current);
        foreach (EventHandler<RealtimeClientStateChangedEventArgs> handler in handlers.GetInvocationList())
        {
            try
            {
                handler(this, eventArgs);
            }
            catch (Exception)
            {
                Log(
                    RealtimeClientLogLevel.Warning,
                    ConsumerCallbackFailureEventId,
                    "A realtime state callback failed.");
            }
        }
    }

    private void Log(RealtimeClientLogLevel level, int eventId, string message)
    {
        try
        {
            _logger.Log(level, eventId, message);
        }
        catch (Exception)
        {
            // Logging is an application extension boundary and must remain best effort.
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(RealtimeClient));
        }
    }

    private void EnsureConnectedForSubscriptionChange()
    {
        if (State != RealtimeClientState.Connected)
        {
            throw new InvalidOperationException(
                "Subscriptions can only be changed while the realtime client is connected.");
        }
    }

    private static async Task ObserveSiblingLoopAsync(Task task, Task completed)
    {
        if (ReferenceEquals(task, completed))
        {
            return;
        }
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The completed loop owns the reconnect outcome; sibling failures are only observed here.
        }
    }

    private static async Task AwaitWithCancellationAsync(Task task, CancellationToken cancellationToken)
    {
        if (!cancellationToken.CanBeCanceled)
        {
            await task.ConfigureAwait(false);
            return;
        }

        var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using (cancellationToken.Register(() => cancelled.TrySetResult(true)))
        {
            if (task != await Task.WhenAny(task, cancelled.Task).ConfigureAwait(false))
            {
                throw new OperationCanceledException(cancellationToken);
            }
        }
        await task.ConfigureAwait(false);
    }
}
