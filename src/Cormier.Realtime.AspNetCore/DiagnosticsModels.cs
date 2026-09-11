using System.Text.Json.Serialization;

namespace Cormier.Realtime.Gateway;

public sealed record GatewayMetricSnapshot(
    long ActiveConnections,
    long PeakConnections,
    long QueueDepth,
    long PeakQueueDepth,
    long ActiveSubscriptions,
    long Messages,
    long Reconnects,
    long AuthenticationFailures,
    long AuthorizationFailures,
    long QueueDrops,
    long RedisErrors,
    long HandlerCancellations,
    double MessagesPerSecond,
    double RedisLatencyMilliseconds,
    bool RedisHealthy,
    bool RedisSubscriptionActive,
    bool Draining);

public sealed record DiagnosticsEndpointSummary(
    string RealtimePath,
    string TicketPath,
    string MetricsPath,
    string DiagnosticsPath,
    int AllowedOriginCount,
    int AllowedNetworkCount,
    string Topology);

public sealed record DiagnosticsSnapshotResponse(
    string ContractVersion,
    DateTimeOffset Timestamp,
    string ServiceName,
    string ServiceVersion,
    string InstanceId,
    long UptimeSeconds,
    string Readiness,
    DiagnosticsEndpointSummary Endpoints,
    GatewayMetricSnapshot Metrics,
    int Connections,
    int AuthenticatedSessions,
    int Subscriptions,
    int QueuedMessages,
    long ManagedMemoryBytes,
    double CpuSeconds,
    LogLevelOverrideResponse[] LogLevelOverrides);

public sealed record ConnectionDiagnostic(
    string ConnectionReference,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastActivity,
    int Subscriptions,
    int QueuedMessages);

public sealed record ConnectionDiagnosticsPage(
    DateTimeOffset Timestamp,
    int Offset,
    int Limit,
    int Total,
    ConnectionDiagnostic[] Items);

public sealed record DiagnosticOperationalEvent(
    string ContractVersion,
    long Sequence,
    DateTimeOffset Timestamp,
    string Kind,
    string InstanceId,
    GatewayMetricSnapshot Snapshot);

public sealed record DiagnosticLogEvent(
    long Sequence,
    DateTimeOffset Timestamp,
    string Level,
    string Category,
    int EventId,
    string? CorrelationId,
    string InstanceId,
    string Message);

public sealed record LogLevelChangeRequest(
    string Category,
    string Level,
    int DurationSeconds,
    string Reason,
    string Scope = "all");

public sealed record LogLevelOverrideResponse(
    string Id,
    string Category,
    string Level,
    string Scope,
    DateTimeOffset StartedAt,
    DateTimeOffset ExpiresAt,
    string State);

public sealed record LogLevelAuditEntry(
    string Id,
    DateTimeOffset Timestamp,
    string Actor,
    string Reason,
    string Category,
    string PreviousLevel,
    string NewLevel,
    string Scope,
    DateTimeOffset ExpiresAt,
    string Outcome,
    string InstanceId);

public sealed record LogLevelAuditPage(
    DateTimeOffset Timestamp,
    int Offset,
    int Limit,
    int Total,
    LogLevelAuditEntry[] Items);

public sealed record DiagnosticsError(string Code, string Message);

public sealed record DiagnosticsCoordinationMessage(
    string Action,
    string Id,
    LogLevelChangeRequest? Request,
    string Actor,
    DateTimeOffset Timestamp,
    string? TargetInstanceId = null);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(DiagnosticsSnapshotResponse))]
[JsonSerializable(typeof(ConnectionDiagnosticsPage))]
[JsonSerializable(typeof(DiagnosticOperationalEvent))]
[JsonSerializable(typeof(DiagnosticLogEvent))]
[JsonSerializable(typeof(LogLevelChangeRequest))]
[JsonSerializable(typeof(LogLevelOverrideResponse))]
[JsonSerializable(typeof(LogLevelOverrideResponse[]))]
[JsonSerializable(typeof(LogLevelAuditEntry))]
[JsonSerializable(typeof(LogLevelAuditPage))]
[JsonSerializable(typeof(DiagnosticsError))]
[JsonSerializable(typeof(DiagnosticsCoordinationMessage))]
[JsonSerializable(typeof(GatewayMetricSnapshot))]
[JsonSerializable(typeof(DiagnosticsEndpointSummary))]
public sealed partial class DiagnosticsJsonSerializerContext : JsonSerializerContext;
