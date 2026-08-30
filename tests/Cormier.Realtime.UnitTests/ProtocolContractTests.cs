using System.Text.Json;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.UnitTests;

public sealed class ProtocolContractTests
{
    [Fact]
    public void MessageEnvelopeUsesSourceGeneratedMetadata()
    {
        var payload = JsonSerializer.SerializeToElement(new { value = 42 });
        var envelope = new MessageEnvelope(
            ProtocolVersions.Current,
            "test.event",
            "correlation-1",
            DateTimeOffset.UnixEpoch,
            "topics/test",
            payload);

        var json = JsonSerializer.Serialize(envelope, RealtimeJsonSerializerContext.Default.MessageEnvelope);
        var roundTrip = JsonSerializer.Deserialize(json, RealtimeJsonSerializerContext.Default.MessageEnvelope);

        Assert.NotNull(roundTrip);
        Assert.Equal(ProtocolVersions.Current, roundTrip.Version);
        Assert.Equal("correlation-1", roundTrip.CorrelationId);
    }
}
