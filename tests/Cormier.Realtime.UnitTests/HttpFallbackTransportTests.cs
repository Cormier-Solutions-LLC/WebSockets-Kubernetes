using Cormier.Realtime.HttpFallback;

namespace Cormier.Realtime.UnitTests;

public sealed class HttpFallbackTransportTests
{
    [Fact]
    public async Task SendPublishedAfterCancellationDoesNotWaitForAReceiver()
    {
        await using var transport = new HttpFallbackTransport();
        transport.CancelPendingSend();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => transport.SendAsync("payload"u8.ToArray(), CancellationToken.None).AsTask());
    }
}
