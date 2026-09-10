import {
  closeCodes,
  createEnvelope,
  messageTypes,
  type ConnectionTicketResponse,
  type JsonValue,
  type MessageEnvelope,
  type ReconnectAdvice,
  type ServerMessageEnvelope,
  validateServerEnvelope,
  WEBSOCKET_SUBPROTOCOL,
} from "./protocol.js";
import { RealtimeConnectionError, RealtimeError, RealtimeQueueError } from "./errors.js";

export type RealtimeClientState = "idle" | "connecting" | "open" | "reconnecting" | "closing" | "closed";

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SessionAuthentication {
  readonly kind: "session";
}

export interface TicketAuthentication {
  readonly kind: "ticket";
  readonly endpoint?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
}

export type RealtimeAuthentication = SessionAuthentication | TicketAuthentication;

export interface ReconnectOptions {
  readonly enabled?: boolean;
  readonly initialDelayMilliseconds?: number;
  readonly maximumDelayMilliseconds?: number;
  readonly jitterRatio?: number;
  readonly maximumAttempts?: number;
}

export interface RealtimeClientOptions {
  readonly url: string | URL;
  readonly authentication?: RealtimeAuthentication;
  readonly maximumQueuedCommands?: number;
  readonly maximumPendingCommands?: number;
  readonly commandTimeoutMilliseconds?: number;
  readonly maximumMessageBytes?: number;
  readonly heartbeatIntervalMilliseconds?: number;
  readonly reconnect?: ReconnectOptions;
  readonly webSocketFactory?: (url: string, protocol: string) => WebSocketLike;
  readonly random?: () => number;
}

export interface RealtimeCloseDetails {
  readonly code: number;
  readonly reason: string;
  readonly expected: boolean;
}

export interface RealtimeClientEvents {
  readonly state: RealtimeClientState;
  readonly close: RealtimeCloseDetails;
  readonly event: ServerMessageEnvelope;
  readonly error: RealtimeError;
}

type Listener<TKey extends keyof RealtimeClientEvents> = (event: RealtimeClientEvents[TKey]) => void;

interface PendingCommand {
  readonly resolve: (envelope: ServerMessageEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

interface QueuedCommand {
  readonly envelope: MessageEnvelope;
  readonly resolve: (envelope: ServerMessageEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  removeAbortListener?: () => void;
}

const OPEN = 1;
const CONNECTING = 0;
const defaultReconnect: Required<ReconnectOptions> = {
  enabled: true,
  initialDelayMilliseconds: 500,
  maximumDelayMilliseconds: 30_000,
  jitterRatio: 0.2,
  maximumAttempts: 12,
};

export class RealtimeClient {
  private readonly options: Required<Pick<RealtimeClientOptions,
    "maximumQueuedCommands" | "maximumPendingCommands" | "commandTimeoutMilliseconds" | "heartbeatIntervalMilliseconds" | "maximumMessageBytes">>
    & RealtimeClientOptions;
  private readonly reconnectOptions: Required<ReconnectOptions>;
  private readonly listeners = new Map<keyof RealtimeClientEvents, Set<(event: never) => void>>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queued: QueuedCommand[] = [];
  private readonly subscriptions = new Map<string, Set<(event: ServerMessageEnvelope) => void>>();
  private socket: WebSocketLike | undefined;
  private stateValue: RealtimeClientState = "idle";
  private connectPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempt = 0;
  private generation = 0;
  private intentionalClose = false;
  private serverReconnectAdvice: ReconnectAdvice | undefined;

  public constructor(options: RealtimeClientOptions) {
    if (options.url.toString().trim().length === 0) {
      throw new TypeError("A WebSocket URL is required.");
    }
    this.options = {
      maximumQueuedCommands: 128,
      maximumPendingCommands: 128,
      commandTimeoutMilliseconds: 10_000,
      heartbeatIntervalMilliseconds: 15_000,
      maximumMessageBytes: 16 * 1024,
      ...options,
    };
    this.reconnectOptions = { ...defaultReconnect, ...options.reconnect };
    this.assertPositiveInteger(this.options.maximumQueuedCommands, "maximumQueuedCommands");
    this.assertPositiveInteger(this.options.maximumPendingCommands, "maximumPendingCommands");
    this.assertPositiveInteger(this.options.commandTimeoutMilliseconds, "commandTimeoutMilliseconds");
    this.assertPositiveInteger(this.options.heartbeatIntervalMilliseconds, "heartbeatIntervalMilliseconds");
    this.assertPositiveInteger(this.options.maximumMessageBytes, "maximumMessageBytes");
    this.assertPositiveInteger(this.reconnectOptions.maximumAttempts, "reconnect.maximumAttempts");
    if (this.reconnectOptions.jitterRatio < 0 || this.reconnectOptions.jitterRatio > 1) {
      throw new RangeError("reconnect.jitterRatio must be between 0 and 1.");
    }
  }

  public get state(): RealtimeClientState {
    return this.stateValue;
  }

  public get desiredSubscriptions(): readonly string[] {
    return [...this.subscriptions.keys()];
  }

  public on<TKey extends keyof RealtimeClientEvents>(type: TKey, listener: Listener<TKey>): () => void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: never) => void);
    return () => listeners?.delete(listener as (event: never) => void);
  }

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "open") {
      return;
    }
    if (this.connectPromise !== undefined) {
      return this.connectPromise;
    }
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.connectPromise = this.openSocket(signal, false)
      .catch((error: unknown) => {
        this.setState("closed");
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  public async disconnect(code = closeCodes.normal, reason = "client_disconnect"): Promise<void> {
    this.intentionalClose = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.setState("closing");
    this.rejectPending(new RealtimeConnectionError("The client disconnected.", "client_disconnect"));
    this.rejectQueued(new RealtimeConnectionError("The client disconnected.", "client_disconnect"));
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && (socket.readyState === OPEN || socket.readyState === CONNECTING)) {
      socket.close(code, reason);
    }
    this.setState("closed");
  }

  public publish<TPayload extends JsonValue>(route: string, payload: TPayload, signal?: AbortSignal): Promise<ServerMessageEnvelope> {
    return this.sendCommand(createEnvelope(messageTypes.publish, route, payload), signal);
  }

  public async subscribe(
    route: string,
    listener: (event: ServerMessageEnvelope) => void,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    let routeListeners = this.subscriptions.get(route);
    const isNewRoute = routeListeners === undefined;
    if (routeListeners === undefined) {
      routeListeners = new Set();
      this.subscriptions.set(route, routeListeners);
    }
    routeListeners.add(listener);
    try {
      if (isNewRoute) {
        await this.sendCommand(createEnvelope(messageTypes.subscribe, route), signal);
      }
    } catch (error: unknown) {
      routeListeners.delete(listener);
      if (routeListeners.size === 0) {
        this.subscriptions.delete(route);
      }
      throw error;
    }
    let active = true;
    return async () => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.subscriptions.get(route);
      current?.delete(listener);
      if (current !== undefined && current.size === 0) {
        this.subscriptions.delete(route);
        if (this.stateValue === "open") {
          await this.sendCommand(createEnvelope(messageTypes.unsubscribe, route));
        }
      }
    };
  }

  public ping(signal?: AbortSignal): Promise<ServerMessageEnvelope> {
    return this.sendCommand(createEnvelope(messageTypes.ping, "system/heartbeat"), signal);
  }

  private async openSocket(signal: AbortSignal | undefined, reconnecting: boolean): Promise<void> {
    signal?.throwIfAborted();
    const generation = ++this.generation;
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const connectionUrl = await this.createConnectionUrl(signal);
    signal?.throwIfAborted();
    const factory = this.options.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol));
    const socket = factory(connectionUrl, WEBSOCKET_SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (!settled) {
          settled = true;
          socket.close(closeCodes.normal, "connect_cancelled");
          reject(new DOMException("The connection was cancelled.", "AbortError"));
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        if (settled || generation !== this.generation) {
          socket.close(closeCodes.normal, "stale_connection");
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        this.reconnectAttempt = 0;
        this.serverReconnectAdvice = undefined;
        this.setState("open");
        this.startHeartbeat();
        resolve();
        void this.restoreSubscriptionsAndFlush();
      };
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", abort);
          reject(new RealtimeConnectionError("The WebSocket connection failed."));
        }
      };
      socket.onclose = (event) => {
        signal?.removeEventListener("abort", abort);
        if (!settled) {
          settled = true;
          reject(new RealtimeConnectionError(`The WebSocket closed during connection (${event.code}).`));
        }
        this.handleClose(event, generation);
      };
    });
  }

  private async createConnectionUrl(signal?: AbortSignal): Promise<string> {
    const url = new URL(this.options.url.toString(), globalThis.location?.href);
    const authentication = this.options.authentication ?? { kind: "session" };
    if (authentication.kind === "ticket") {
      const endpoint = new URL(authentication.endpoint?.toString() ?? "/realtime/tickets", url);
      const fetcher = authentication.fetch ?? globalThis.fetch;
      if (fetcher === undefined) {
        throw new RealtimeConnectionError("Ticket authentication requires the Fetch API.", "ticket_unavailable");
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new RealtimeConnectionError(`Connection ticket request failed (${response.status}).`, "ticket_rejected");
      }
      const value: unknown = await response.json();
      if (!this.isTicketResponse(value)) {
        throw new RealtimeConnectionError("Connection ticket response was invalid.", "ticket_invalid");
      }
      url.searchParams.set("ticket", value.ticket);
    }
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new TypeError("The realtime URL must use ws, wss, http, or https.");
    }
    return url.toString();
  }

  private sendCommand(envelope: MessageEnvelope, signal?: AbortSignal): Promise<ServerMessageEnvelope> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The command was cancelled.", "AbortError"));
    }
    return new Promise<ServerMessageEnvelope>((resolve, reject) => {
      if (this.socket?.readyState === OPEN && this.stateValue === "open") {
        this.transmit({ envelope, resolve, reject, ...(signal === undefined ? {} : { signal }) });
        return;
      }
      if (this.queued.length >= this.options.maximumQueuedCommands) {
        reject(new RealtimeQueueError());
        return;
      }
      const command: QueuedCommand = { envelope, resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        const abort = () => this.failQueuedCommand(command, this.abortError(signal));
        signal.addEventListener("abort", abort, { once: true });
        command.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.queued.push(command);
      if (this.stateValue === "idle" || this.stateValue === "closed") {
        void this.connect().catch((error: unknown) => {
          const normalized = this.normalizeError(error);
          this.setState("closed");
          this.rejectQueued(normalized);
          this.emit("error", normalized);
        });
      }
    });
  }

  private transmit(command: QueuedCommand): void {
    command.removeAbortListener?.();
    delete command.removeAbortListener;
    if (command.signal?.aborted) {
      command.reject(this.abortError(command.signal));
      return;
    }
    if (this.pending.size >= this.options.maximumPendingCommands) {
      command.reject(new RealtimeQueueError());
      return;
    }
    const socket = this.socket;
    if (socket?.readyState !== OPEN) {
      if (this.queued.length >= this.options.maximumQueuedCommands) {
        command.reject(new RealtimeQueueError());
      } else {
        this.queued.push(command);
      }
      return;
    }
    const serialized = JSON.stringify(command.envelope);
    if (new TextEncoder().encode(serialized).byteLength > this.options.maximumMessageBytes) {
      command.reject(new RealtimeError("The command exceeds the configured message-size limit.", "message_too_large", command.envelope.correlationId));
      return;
    }
    const correlationId = command.envelope.correlationId;
    const removeAbortListener = this.addPendingAbortListener(command, correlationId);
    const timer = setTimeout(() => {
      if (this.pending.delete(correlationId)) {
        removeAbortListener();
        command.reject(new RealtimeConnectionError("The command acknowledgement timed out.", "command_timeout"));
      }
    }, this.options.commandTimeoutMilliseconds);
    this.pending.set(correlationId, { resolve: command.resolve, reject: command.reject, timer, removeAbortListener });
    try {
      socket.send(serialized);
    } catch (error: unknown) {
      clearTimeout(timer);
      this.pending.delete(correlationId);
      removeAbortListener();
      command.reject(this.normalizeError(error));
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.emit("error", new RealtimeError("The server sent a non-text message.", "invalid_message_type"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      this.emit("error", new RealtimeError("The server sent malformed JSON.", "invalid_envelope"));
      return;
    }
    const validation = validateServerEnvelope(parsed);
    if (!validation.valid || validation.value === undefined) {
      this.emit("error", new RealtimeError(validation.message ?? "The server envelope was invalid.", validation.errorCode ?? "invalid_envelope"));
      return;
    }
    const envelope = validation.value;
    if (envelope.type === messageTypes.serviceRestart) {
      if (envelope.reconnect !== null && envelope.reconnect !== undefined) {
        this.serverReconnectAdvice = envelope.reconnect;
      }
      return;
    }
    if (envelope.type === messageTypes.event) {
      this.emit("event", envelope);
      for (const listener of this.subscriptions.get(envelope.route) ?? []) {
        listener(envelope);
      }
      return;
    }
    const pending = this.pending.get(envelope.correlationId);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    this.pending.delete(envelope.correlationId);
    if (envelope.type === messageTypes.error) {
      const error = RealtimeError.fromEnvelope(envelope);
      pending.reject(error);
      this.emit("error", error);
    } else {
      pending.resolve(envelope);
    }
  }

  private handleClose(event: CloseEvent, generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.stopHeartbeat();
    this.socket = undefined;
    const expected = this.intentionalClose || event.code === closeCodes.normal;
    this.rejectPending(new RealtimeConnectionError(`The WebSocket closed (${event.code}).`, "connection_closed"));
    this.emit("close", { code: event.code, reason: event.reason, expected });
    if (expected || !this.reconnectOptions.enabled) {
      this.setState("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.intentionalClose) {
      return;
    }
    if (this.reconnectAttempt >= this.reconnectOptions.maximumAttempts) {
      this.setState("closed");
      const error = new RealtimeConnectionError("The reconnect attempt limit was reached.", "reconnect_exhausted");
      this.rejectQueued(error);
      this.emit("error", error);
      return;
    }
    this.setState("reconnecting");
    const advice = this.serverReconnectAdvice;
    const initial = advice?.initialDelayMilliseconds ?? this.reconnectOptions.initialDelayMilliseconds;
    const maximum = advice?.maximumDelayMilliseconds ?? this.reconnectOptions.maximumDelayMilliseconds;
    const jitter = advice?.jitterRatio ?? this.reconnectOptions.jitterRatio;
    const exponential = Math.min(maximum, initial * (2 ** this.reconnectAttempt));
    const random = this.options.random?.() ?? Math.random();
    const delay = Math.max(0, Math.round(exponential * (1 - jitter + (2 * jitter * random))));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket(undefined, true).catch((error: unknown) => {
        this.emit("error", this.normalizeError(error));
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async restoreSubscriptionsAndFlush(): Promise<void> {
    try {
      const queuedSubscriptions = new Set(this.queued
        .filter((command) => command.envelope.type === messageTypes.subscribe)
        .map((command) => command.envelope.route));
      for (const route of this.subscriptions.keys()) {
        if (!queuedSubscriptions.has(route)) {
          await this.sendCommand(createEnvelope(messageTypes.subscribe, route));
        }
      }
      while (this.queued.length > 0 && this.stateValue === "open") {
        const command = this.queued.shift();
        if (command !== undefined) {
          this.transmit(command);
        }
      }
    } catch (error: unknown) {
      this.emit("error", this.normalizeError(error));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.ping().catch((error: unknown) => {
        this.emit("error", this.normalizeError(error));
        this.socket?.close(closeCodes.heartbeatTimeout, "heartbeat_failed");
      });
    }, this.options.heartbeatIntervalMilliseconds);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectQueued(error: Error): void {
    for (const command of this.queued.splice(0)) {
      command.removeAbortListener?.();
      command.reject(error);
    }
  }

  private failQueuedCommand(command: QueuedCommand, error: unknown): void {
    const index = this.queued.indexOf(command);
    if (index >= 0) {
      this.queued.splice(index, 1);
      command.removeAbortListener?.();
      command.reject(error instanceof Error ? error : this.normalizeError(error));
    }
  }

  private addPendingAbortListener(command: QueuedCommand, correlationId: string): () => void {
    const signal = command.signal;
    if (signal === undefined) {
      return () => undefined;
    }
    const abort = () => {
      const pending = this.pending.get(correlationId);
      if (pending !== undefined && this.pending.delete(correlationId)) {
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        command.reject(this.abortError(signal));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  private abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The command was cancelled.", "AbortError");
  }

  private emit<TKey extends keyof RealtimeClientEvents>(type: TKey, event: RealtimeClientEvents[TKey]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }

  private setState(state: RealtimeClientState): void {
    if (this.stateValue !== state) {
      this.stateValue = state;
      this.emit("state", state);
    }
  }

  private normalizeError(error: unknown): RealtimeError {
    return error instanceof RealtimeError
      ? error
      : new RealtimeConnectionError(error instanceof Error ? error.message : "The realtime operation failed.");
  }

  private isTicketResponse(value: unknown): value is ConnectionTicketResponse {
    return typeof value === "object"
      && value !== null
      && "ticket" in value
      && typeof value.ticket === "string"
      && value.ticket.length >= 32
      && "expiresAt" in value
      && typeof value.expiresAt === "string"
      && !Number.isNaN(Date.parse(value.expiresAt));
  }

  private assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer.`);
    }
  }
}
