using System.Net.WebSockets;
using System.Threading.Channels;
using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.HttpFallback;

internal sealed class HttpFallbackTransport : IRealtimeServerTransport, IInterruptibleRealtimeServerTransport
{
    private readonly Channel<HttpFallbackPayload> _outbound = Channel.CreateBounded<HttpFallbackPayload>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = true,
        AllowSynchronousContinuations = false,
    });
    private HttpFallbackPayload? _pending;
    private int _open = 1;

    public bool IsOpen => Volatile.Read(ref _open) == 1;

    public async ValueTask SendAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(!IsOpen, this);
        var pending = new HttpFallbackPayload(payload.ToArray());
        Volatile.Write(ref _pending, pending);
        try
        {
            await _outbound.Writer.WriteAsync(pending, cancellationToken);
            await pending.Consumed.Task.WaitAsync(cancellationToken);
        }
        finally
        {
            Interlocked.CompareExchange(ref _pending, null, pending);
        }
    }

    public ValueTask<HttpFallbackPayload> ReadAsync(CancellationToken cancellationToken) =>
        _outbound.Reader.ReadAsync(cancellationToken);

    public async IAsyncEnumerable<HttpFallbackPayload> ReadAllAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var pending in _outbound.Reader.ReadAllAsync(cancellationToken))
        {
            try
            {
                yield return pending;
            }
            finally
            {
                pending.Complete();
            }
        }
    }

    public ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken)
    {
        Close();
        return ValueTask.CompletedTask;
    }

    public void Abort() => Close();

    public void CancelPendingSend() => Interlocked.Exchange(ref _pending, null)?.Cancel();

    public ValueTask DisposeAsync()
    {
        Close();
        return ValueTask.CompletedTask;
    }

    private void Close()
    {
        if (Interlocked.Exchange(ref _open, 0) == 1)
        {
            _outbound.Writer.TryComplete();
            CancelPendingSend();
        }
    }

    internal sealed record HttpFallbackPayload(byte[] Payload)
    {
        public TaskCompletionSource Consumed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Complete() => Consumed.TrySetResult();
        public void Cancel() => Consumed.TrySetCanceled();
    }
}
