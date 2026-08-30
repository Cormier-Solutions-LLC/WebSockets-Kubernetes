using System.Text.Json;
using System.Text.Json.Serialization;

namespace Propago.Realtime.Contracts;

public static class ProtocolVersions
{
    public const string Current = "1.0";
}

public sealed record MessageEnvelope(
    string Version,
    string Type,
    string CorrelationId,
    DateTimeOffset Timestamp,
    JsonElement? Payload);

public sealed record HealthStatusResponse(
    string Status,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string>? Checks = null);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(MessageEnvelope))]
[JsonSerializable(typeof(HealthStatusResponse))]
[JsonSerializable(typeof(Dictionary<string, string>))]
public sealed partial class RealtimeJsonSerializerContext : JsonSerializerContext;
