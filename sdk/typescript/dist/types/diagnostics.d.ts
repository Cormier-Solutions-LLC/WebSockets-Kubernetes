export interface DiagnosticsClientOptions {
    baseUrl?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
    onStreamError?: (error: Error) => void;
    streamRetryMilliseconds?: number;
}
export interface GatewayMetricSnapshot {
    activeConnections: number;
    peakConnections: number;
    queueDepth: number;
    peakQueueDepth: number;
    activeSubscriptions: number;
    messages: number;
    reconnects: number;
    authenticationFailures: number;
    authorizationFailures: number;
    queueDrops: number;
    redisErrors: number;
    handlerCancellations: number;
    messagesPerSecond: number;
    redisLatencyMilliseconds: number;
    redisHealthy: boolean;
    redisSubscriptionActive: boolean;
    draining: boolean;
}
export interface DiagnosticsSnapshot {
    contractVersion: string;
    timestamp: string;
    serviceName: string;
    serviceVersion: string;
    instanceId: string;
    uptimeSeconds: number;
    readiness: string;
    endpoints: {
        realtimePath: string;
        ticketPath: string;
        metricsPath: string;
        diagnosticsPath: string;
        allowedOriginCount: number;
        allowedNetworkCount: number;
        topology: string;
    };
    metrics: GatewayMetricSnapshot;
    connections: number;
    authenticatedSessions: number;
    subscriptions: number;
    queuedMessages: number;
    managedMemoryBytes: number;
    cpuSeconds: number;
    logLevelOverrides: LogLevelOverride[];
}
export interface LogLevelChange {
    category: string;
    level: "Trace" | "Debug" | "Information" | "Warning" | "Error" | "Critical";
    durationSeconds: number;
    reason: string;
    scope?: "all" | "instance";
}
export interface LogLevelOverride {
    id: string;
    category: string;
    level: LogLevelChange["level"];
    scope: "all" | "instance";
    startedAt: string;
    expiresAt: string;
    state: string;
}
export interface DiagnosticLogEvent {
    sequence: number;
    timestamp: string;
    level: string;
    category: string;
    eventId: number;
    correlationId?: string;
    instanceId: string;
    message: string;
}
export interface DiagnosticOperationalEvent {
    contractVersion: string;
    sequence: number;
    timestamp: string;
    kind: string;
    instanceId: string;
    snapshot: GatewayMetricSnapshot;
}
export interface LogLevelAuditEntry {
    id: string;
    timestamp: string;
    actor: string;
    reason: string;
    category: string;
    previousLevel: string;
    newLevel: string;
    scope: string;
    expiresAt: string;
    outcome: string;
    instanceId: string;
}
export interface LogLevelAuditPage {
    timestamp: string;
    offset: number;
    limit: number;
    total: number;
    items: LogLevelAuditEntry[];
}
export interface LogTailFilter {
    level?: string;
    category?: string;
    instance?: string;
    correlation?: string;
    durationSeconds?: number;
}
export declare class DiagnosticsClient {
    #private;
    constructor(options?: DiagnosticsClientOptions);
    snapshot(signal?: AbortSignal): Promise<DiagnosticsSnapshot>;
    activeLogLevels(signal?: AbortSignal): Promise<LogLevelOverride[]>;
    audit(offset?: number, limit?: number, signal?: AbortSignal): Promise<LogLevelAuditPage>;
    applyLogLevel(change: LogLevelChange, signal?: AbortSignal): Promise<LogLevelOverride>;
    revertLogLevel(id: string, signal?: AbortSignal): Promise<void>;
    streamEvents(onEvent: (event: DiagnosticOperationalEvent) => void): () => void;
    tailLogs(filter: LogTailFilter, onEvent: (event: DiagnosticLogEvent) => void): () => void;
}
//# sourceMappingURL=diagnostics.d.ts.map