using System.Text.Json;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.Client.Tests;

public sealed class ProtocolFixtureTests
{
    [Theory]
    [InlineData("topics/orders", "orders", null)]
    [InlineData("users/user-1/topics/orders", "orders", "user-1")]
    public void TypedRoutesMatchGatewayTopicAndUserScopes(string value, string topic, string? userId)
    {
        Assert.True(RealtimeRoute.TryParse(value, out var route));
        Assert.Equal(value, route.Value);
        Assert.Equal(topic, route.Topic);
        Assert.Equal(userId, route.UserId);
    }

    [Theory]
    [InlineData("")]
    [InlineData("orders")]
    [InlineData("topics/orders/extra")]
    [InlineData("users/user-1/topics/orders/extra")]
    [InlineData("topics/order secret")]
    public void TypedRoutesRejectInvalidOrAmbiguousValues(string value)
    {
        Assert.False(RealtimeRoute.TryParse(value, out _));
    }

    [Fact]
    public void UserRouteFactoryEnforcesTheProtocolRouteLimit()
    {
        Assert.Throws<ArgumentException>(() =>
            RealtimeRoute.ForUserTopic(new string('u', 128), new string('t', 128)));
    }

    [Fact]
    public void SharedClientFixturesRoundTripAndValidate()
    {
        using var fixture = LoadFixture();
        var now = DateTimeOffset.Parse("2026-08-30T17:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        foreach (var element in fixture.RootElement.GetProperty("validClientEnvelopes").EnumerateArray())
        {
            var envelope = element.Deserialize(RealtimeJsonSerializerContext.Default.MessageEnvelope);
            var result = ProtocolValidator.Validate(envelope, now);
            var roundTrip = JsonSerializer.SerializeToElement(
                envelope,
                RealtimeJsonSerializerContext.Default.MessageEnvelope);

            Assert.True(result.IsValid, result.ErrorMessage);
            Assert.Equal(element.GetProperty("version").GetString(), roundTrip.GetProperty("version").GetString());
            Assert.Equal(element.GetProperty("type").GetString(), roundTrip.GetProperty("type").GetString());
            Assert.Equal(element.GetProperty("route").GetString(), roundTrip.GetProperty("route").GetString());
        }
    }

    [Fact]
    public void SharedServerFixturesRoundTripAndValidate()
    {
        using var fixture = LoadFixture();

        foreach (var element in fixture.RootElement.GetProperty("validServerEnvelopes").EnumerateArray())
        {
            var envelope = element.Deserialize(RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);

            Assert.True(ProtocolValidator.Validate(envelope).IsValid);
            Assert.Equal(element.GetProperty("type").GetString(), envelope?.Type);
        }
    }

    [Fact]
    public void UnknownServerExtensionFieldsRemainForwardCompatible()
    {
        const string json = """
            {
              "version": "1.0",
              "type": "event",
              "correlationId": "extension-1",
              "timestamp": "2026-08-30T17:00:00Z",
              "route": "topics/orders",
              "futureExtension": { "enabled": true }
            }
            """;

        var envelope = JsonSerializer.Deserialize(
            json,
            RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);

        Assert.True(ProtocolValidator.Validate(envelope).IsValid);
    }

    [Fact]
    public void InvalidSharedFixturesReturnExpectedErrorCodes()
    {
        using var fixture = LoadFixture();
        var now = DateTimeOffset.Parse("2026-08-30T17:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        foreach (var item in fixture.RootElement.GetProperty("invalidEnvelopes").EnumerateArray())
        {
            var envelope = item.GetProperty("value")
                .Deserialize(RealtimeJsonSerializerContext.Default.MessageEnvelope);
            var result = ProtocolValidator.Validate(envelope, now);

            Assert.False(result.IsValid);
            Assert.Equal(item.GetProperty("errorCode").GetString(), result.ErrorCode);
        }
    }

    private static JsonDocument LoadFixture() => JsonDocument.Parse(
        File.ReadAllText(Path.Join(AppContext.BaseDirectory, "protocol", "fixtures", "v1", "envelopes.json")));
}
