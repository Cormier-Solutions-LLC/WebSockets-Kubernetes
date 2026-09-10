using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cormier.Realtime.Contracts;

public static class ProtocolVersions
{
    public const string Current = "1.0";
}

public static class ProtocolMessageTypes
{
    public const string Ping = "ping";
    public const string Subscribe = "subscribe";
    public const string Unsubscribe = "unsubscribe";
    public const string Publish = "publish";
    public const string Acknowledge = "ack";
    public const string Event = "event";
    public const string Error = "error";
    public const string ServiceRestart = "service.restart";
}

public static class ProtocolErrorCodes
{
    public const string InvalidEnvelope = "invalid_envelope";
    public const string UnsupportedVersion = "unsupported_version";
    public const string UnsupportedType = "unsupported_type";
    public const string DuplicateCorrelation = "duplicate_correlation";
    public const string MessageTooLarge = "message_too_large";
    public const string FragmentedMessageRejected = "fragmented_message_rejected";
    public const string Unauthorized = "unauthorized";
    public const string QueueSaturated = "queue_saturated";
    public const string ServiceDraining = "service_draining";
    public const string InternalError = "internal_error";
}

public static class RealtimeCloseCodes
{
    public const int Normal = 1000;
    public const int GoingAway = 1001;
    public const int ProtocolError = 1002;
    public const int InvalidMessageType = 1003;
    public const int MessageTooLarge = 1009;
    public const int InternalError = 1011;
    public const int ServiceRestart = 1012;
    public const int AuthenticationExpired = 4003;
    public const int SlowConsumer = 4008;
    public const int HeartbeatTimeout = 4009;
}

public sealed record MessageEnvelope(
    string Version,
    string Type,
    string CorrelationId,
    DateTimeOffset Timestamp,
    string Route,
    JsonElement Payload);

public sealed record ServerMessageEnvelope(
    string Version,
    string Type,
    string CorrelationId,
    DateTimeOffset Timestamp,
    string Route,
    JsonElement? Payload = null,
    ProtocolError? Error = null,
    ReconnectAdvice? Reconnect = null);

public sealed record ProtocolError(string Code, string Message);

public sealed record ReconnectAdvice(
    [property: JsonRequired] int InitialDelayMilliseconds,
    [property: JsonRequired] int MaximumDelayMilliseconds,
    [property: JsonRequired] double JitterRatio,
    [property: JsonRequired] bool Reauthenticate);

public sealed record RealtimeIdentity(
    string TenantId,
    string UserId,
    IReadOnlyList<string> AllowedTopics,
    DateTimeOffset ExpiresAt);

public sealed record RedisSessionRecord(
    string TenantId,
    string UserId,
    IReadOnlyList<string> AllowedTopics,
    DateTimeOffset ExpiresAt,
    bool Revoked = false);

public sealed record ConnectionTicketRecord(
    string TenantId,
    string UserId,
    IReadOnlyList<string> AllowedTopics,
    DateTimeOffset ExpiresAt,
    string Audience);

public sealed record ConnectionTicketResponse(string Ticket, DateTimeOffset ExpiresAt);

public sealed record RealtimeBusMessage(
    string MessageId,
    string TenantId,
    string? UserId,
    string Topic,
    string CorrelationId,
    DateTimeOffset Timestamp,
    JsonElement Payload,
    string SourceInstance);

public sealed record DurableStreamMessage(
    string EventClass,
    string MessageId,
    string TenantId,
    string? UserId,
    string Topic,
    string CorrelationId,
    DateTimeOffset Timestamp,
    JsonElement Payload,
    string SourceInstance);

public sealed record HealthStatusResponse(
    string Status,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string>? Checks = null);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(MessageEnvelope))]
[JsonSerializable(typeof(ServerMessageEnvelope))]
[JsonSerializable(typeof(ProtocolError))]
[JsonSerializable(typeof(ReconnectAdvice))]
[JsonSerializable(typeof(RealtimeIdentity))]
[JsonSerializable(typeof(RedisSessionRecord))]
[JsonSerializable(typeof(ConnectionTicketRecord))]
[JsonSerializable(typeof(ConnectionTicketResponse))]
[JsonSerializable(typeof(RealtimeBusMessage))]
[JsonSerializable(typeof(DurableStreamMessage))]
[JsonSerializable(typeof(HealthStatusResponse))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(string[]))]
public sealed partial class RealtimeJsonSerializerContext : JsonSerializerContext;
