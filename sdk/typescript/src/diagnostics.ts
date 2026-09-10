export interface DiagnosticsClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  eventSourceFactory?: (url: string) => EventSource;
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

export interface LogLevelOverride extends LogLevelChange {
  id: string;
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

export class DiagnosticsClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #eventSourceFactory: (url: string) => EventSource;

  constructor(options: DiagnosticsClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/diagnostics/v1").replace(/\/$/, "");
    this.#headers = { ...(options.headers ?? {}) };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url, { withCredentials: true }));
  }

  snapshot(signal?: AbortSignal): Promise<DiagnosticsSnapshot> {
    return this.#request<DiagnosticsSnapshot>("/snapshot", signal ? { signal } : {});
  }

  activeLogLevels(signal?: AbortSignal): Promise<LogLevelOverride[]> {
    return this.#request<LogLevelOverride[]>("/logging/overrides", signal ? { signal } : {});
  }

  audit(offset = 0, limit = 25, signal?: AbortSignal): Promise<LogLevelAuditPage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.#request<LogLevelAuditPage>(`/logging/audit?${query}`, signal ? { signal } : {});
  }

  applyLogLevel(change: LogLevelChange, signal?: AbortSignal): Promise<LogLevelOverride> {
    return this.#request<LogLevelOverride>("/logging/overrides", {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...change, scope: change.scope ?? "all" }),
    });
  }

  async revertLogLevel(id: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(`/logging/overrides/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  }

  streamEvents(onEvent: (event: DiagnosticOperationalEvent) => void): () => void {
    return this.#stream<DiagnosticOperationalEvent>("/events", {}, onEvent);
  }

  tailLogs(filter: LogTailFilter, onEvent: (event: DiagnosticLogEvent) => void): () => void {
    return this.#stream<DiagnosticLogEvent>("/logs/tail", filter as Record<string, string | number | undefined>, onEvent);
  }

  #stream<T>(path: string, query: Record<string, string | number | undefined>, onEvent: (event: T) => void): () => void {
    const parameters = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined) parameters.set(name, String(value));
    const suffix = parameters.size === 0 ? "" : `?${parameters}`;
    const source = this.#eventSourceFactory(`${this.#baseUrl}${path}${suffix}`);
    source.onmessage = (event) => onEvent(JSON.parse(event.data) as T);
    return () => source.close();
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { ...this.#headers, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`Diagnostics request failed with HTTP ${response.status}.`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
}
