namespace Cormier.Realtime.Contracts;

public readonly record struct ProtocolValidationResult(bool IsValid, string? ErrorCode, string? ErrorMessage)
{
    public static ProtocolValidationResult Valid => new(true, null, null);

    public static ProtocolValidationResult Invalid(string code, string message) => new(false, code, message);
}

public static class ProtocolValidator
{
    public const int MaximumCorrelationIdLength = 128;
    public const int MaximumRouteLength = 256;
    public const int MaximumReconnectDelayMilliseconds = 300_000;

    public static ProtocolValidationResult Validate(MessageEnvelope? envelope, DateTimeOffset now)
    {
        if (envelope is null)
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "The message envelope is required.");
        }

        if (!string.Equals(envelope.Version, ProtocolVersions.Current, StringComparison.Ordinal))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.UnsupportedVersion,
                $"Protocol version '{envelope.Version}' is not supported.");
        }

        if (!IsSupportedClientType(envelope.Type))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.UnsupportedType,
                $"Message type '{envelope.Type}' is not supported.");
        }

        if (!IsValidCorrelationId(envelope.CorrelationId))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "CorrelationId is required and must not exceed 128 characters.");
        }

        if (envelope.Timestamp < now.AddMinutes(-5) || envelope.Timestamp > now.AddMinutes(1))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "Timestamp is outside the accepted clock-skew window.");
        }

        if (string.IsNullOrWhiteSpace(envelope.Route) || envelope.Route.Length > MaximumRouteLength)
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "Route is required and must not exceed 256 characters.");
        }

        if (string.Equals(envelope.Type, ProtocolMessageTypes.Publish, StringComparison.Ordinal) &&
            envelope.Payload.ValueKind is System.Text.Json.JsonValueKind.Undefined or System.Text.Json.JsonValueKind.Null)
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "Publish payload is required and must not be null.");
        }

        return ProtocolValidationResult.Valid;
    }

    public static ProtocolValidationResult Validate(ServerMessageEnvelope? envelope)
    {
        if (envelope is null)
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "The server message envelope is required.");
        }

        if (!string.Equals(envelope.Version, ProtocolVersions.Current, StringComparison.Ordinal))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.UnsupportedVersion,
                "The server message protocol version is not supported.");
        }

        if (!IsSupportedServerType(envelope.Type))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.UnsupportedType,
                "The server message type is not supported.");
        }

        if (!IsValidCorrelationId(envelope.CorrelationId) ||
            envelope.Timestamp == default ||
            string.IsNullOrWhiteSpace(envelope.Route) ||
            envelope.Route.Length > MaximumRouteLength)
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "The server message correlation and route fields are invalid.");
        }

        if (string.Equals(envelope.Type, ProtocolMessageTypes.Error, StringComparison.Ordinal) &&
            (envelope.Error is null ||
             string.IsNullOrWhiteSpace(envelope.Error.Code) ||
             string.IsNullOrWhiteSpace(envelope.Error.Message)))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "Error messages require a structured protocol error.");
        }

        if (envelope.Reconnect is not null &&
            (envelope.Reconnect.InitialDelayMilliseconds < 0 ||
             envelope.Reconnect.MaximumDelayMilliseconds < envelope.Reconnect.InitialDelayMilliseconds ||
             envelope.Reconnect.MaximumDelayMilliseconds > MaximumReconnectDelayMilliseconds ||
             double.IsNaN(envelope.Reconnect.JitterRatio) ||
             double.IsInfinity(envelope.Reconnect.JitterRatio) ||
             envelope.Reconnect.JitterRatio is < 0 or > 1))
        {
            return ProtocolValidationResult.Invalid(
                ProtocolErrorCodes.InvalidEnvelope,
                "Reconnect advice is outside the supported bounds.");
        }

        return ProtocolValidationResult.Valid;
    }

    public static bool IsValidCorrelationId(string correlationId) =>
        !string.IsNullOrWhiteSpace(correlationId) &&
        correlationId.Length <= MaximumCorrelationIdLength;

    private static bool IsSupportedClientType(string type) =>
        string.Equals(type, ProtocolMessageTypes.Ping, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Subscribe, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Unsubscribe, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Publish, StringComparison.Ordinal);

    private static bool IsSupportedServerType(string type) =>
        string.Equals(type, ProtocolMessageTypes.Acknowledge, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Event, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Error, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.Ping, StringComparison.Ordinal) ||
        string.Equals(type, ProtocolMessageTypes.ServiceRestart, StringComparison.Ordinal);
}
