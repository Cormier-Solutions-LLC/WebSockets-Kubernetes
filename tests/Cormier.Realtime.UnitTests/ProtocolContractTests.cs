using System.Text.Json;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.UnitTests;

public sealed class ProtocolContractTests
{
    private static readonly DateTimeOffset FixtureNow = DateTimeOffset.Parse(
        "2026-08-30T17:00:30.000Z",
        System.Globalization.CultureInfo.InvariantCulture);

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

    [Fact]
    public void LanguageNeutralFixturesMatchDotNetProtocolContract()
    {
        var relativePath = Path.Join("protocol", "fixtures", "v1", "envelopes.json");
        var fixturePath = Path.GetFullPath(relativePath, AppContext.BaseDirectory);
        using var fixtures = JsonDocument.Parse(File.ReadAllText(fixturePath));
        var root = fixtures.RootElement;

        Assert.Equal(ProtocolVersions.Current, root.GetProperty("protocolVersion").GetString());
        Assert.Equal(RealtimeWebSocketHandler.SubProtocol, root.GetProperty("subprotocol").GetString());

        foreach (var element in root.GetProperty("validClientEnvelopes").EnumerateArray())
        {
            var envelope = element.Deserialize(RealtimeJsonSerializerContext.Default.MessageEnvelope);
            Assert.True(ProtocolValidator.Validate(envelope, FixtureNow).IsValid);
        }

        foreach (var element in root.GetProperty("validServerEnvelopes").EnumerateArray())
        {
            var envelope = element.Deserialize(RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);
            Assert.NotNull(envelope);
            Assert.Equal(ProtocolVersions.Current, envelope.Version);
        }

        foreach (var fixture in root.GetProperty("invalidEnvelopes").EnumerateArray())
        {
            var envelope = fixture.GetProperty("value")
                .Deserialize(RealtimeJsonSerializerContext.Default.MessageEnvelope);
            var result = ProtocolValidator.Validate(envelope, FixtureNow);
            Assert.False(result.IsValid);
            Assert.Equal(fixture.GetProperty("errorCode").GetString(), result.ErrorCode);
        }
    }
}
