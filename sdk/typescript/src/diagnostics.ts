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
  correlationId: string | null;
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
  readonly #onStreamError: (error: Error) => void;
  readonly #streamRetryMilliseconds: number;

  constructor(options: DiagnosticsClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/diagnostics/v1").replace(/\/$/, "");
    this.#headers = { ...(options.headers ?? {}) };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#onStreamError = options.onStreamError ?? (() => undefined);
    this.#streamRetryMilliseconds = options.streamRetryMilliseconds ?? 1_000;
    if (!Number.isSafeInteger(this.#streamRetryMilliseconds)
      || this.#streamRetryMilliseconds < 100
      || this.#streamRetryMilliseconds > 60_000) {
      throw new RangeError("streamRetryMilliseconds must be between 100 and 60000.");
    }
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
    return this.#stream<DiagnosticLogEvent>(
      "/logs/tail",
      filter as Record<string, string | number | undefined>,
      onEvent,
      filter.durationSeconds,
    );
  }

  #stream<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    onEvent: (event: T) => void,
    durationSeconds?: number,
  ): () => void {
    const parameters = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined) parameters.set(name, String(value));
    const suffix = parameters.size === 0 ? "" : `?${parameters}`;
    const cancellation = new AbortController();
    const durationTimer = durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? setTimeout(() => cancellation.abort(), durationSeconds * 1_000)
      : undefined;
    void this.#runStream(`${this.#baseUrl}${path}${suffix}`, cancellation, onEvent)
      .finally(() => {
        if (durationTimer !== undefined) clearTimeout(durationTimer);
      });
    return () => {
      if (durationTimer !== undefined) clearTimeout(durationTimer);
      cancellation.abort();
    };
  }

  async #runStream<T>(url: string, cancellation: AbortController, onEvent: (event: T) => void): Promise<void> {
    while (!cancellation.signal.aborted) {
      try {
        if (await this.#consumeStream(url, cancellation, onEvent)) {
          return;
        }
      } catch (error: unknown) {
        if (cancellation.signal.aborted) {
          return;
        }
        this.#onStreamError(error instanceof Error ? error : new Error("The diagnostics stream failed."));
        if (error instanceof DiagnosticsStreamHttpError && error.isPermanent) {
          return;
        }
      }
      await this.#waitForStreamRetry(cancellation.signal);
    }
  }

  async #consumeStream<T>(url: string, cancellation: AbortController, onEvent: (event: T) => void): Promise<boolean> {
    const response = await this.#fetch(url, {
      credentials: "same-origin",
      headers: this.#headers,
      signal: cancellation.signal,
    });
    if (!response.ok || response.body === null) {
      throw new DiagnosticsStreamHttpError(response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!cancellation.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separator.length);
          if (this.#dispatchStreamBlock(block, onEvent)) {
            cancellation.abort();
            return true;
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (done) {
          return false;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return false;
  }

  async #waitForStreamRetry(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const complete = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", complete);
        resolve();
      };
      const timer = setTimeout(complete, this.#streamRetryMilliseconds);
      signal.addEventListener("abort", complete, { once: true });
    });
  }

  #dispatchStreamBlock<T>(block: string, onEvent: (event: T) => void): boolean {
    let eventName = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (eventName === "disconnect") {
      return true;
    }
    if (eventName === "message" && data.length > 0) {
      onEvent(JSON.parse(data.join("\n")) as T);
    }
    return false;
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

class DiagnosticsStreamHttpError extends Error {
  readonly isPermanent: boolean;

  constructor(status: number) {
    super(`Diagnostics stream failed with HTTP ${status}.`);
    this.name = "DiagnosticsStreamHttpError";
    this.isPermanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}
