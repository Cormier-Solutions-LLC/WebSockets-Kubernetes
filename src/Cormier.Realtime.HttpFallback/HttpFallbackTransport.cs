using System.Net.WebSockets;
using System.Threading.Channels;
using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.HttpFallback;

internal sealed class HttpFallbackTransport(int capacity) : IRealtimeServerTransport
{
    private readonly Channel<byte[]> _outbound = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(capacity)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = true,
        AllowSynchronousContinuations = false,
    });
    private int _open = 1;

    public bool IsOpen => Volatile.Read(ref _open) == 1;

    public ChannelReader<byte[]> Outbound => _outbound.Reader;

    public async ValueTask SendAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(!IsOpen, this);
        await _outbound.Writer.WriteAsync(payload.ToArray(), cancellationToken);
    }

    public ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken)
    {
        Close();
        return ValueTask.CompletedTask;
    }

    public void Abort() => Close();

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
        }
    }
}
