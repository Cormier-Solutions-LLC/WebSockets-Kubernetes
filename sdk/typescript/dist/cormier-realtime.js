// src/protocol.ts
var SDK_VERSION = "0.1.0";
var PROTOCOL_VERSION = "1.0";
var WEBSOCKET_SUBPROTOCOL = "cormier.realtime.v1";
var messageTypes = {
  ping: "ping",
  subscribe: "subscribe",
  unsubscribe: "unsubscribe",
  publish: "publish",
  acknowledge: "ack",
  event: "event",
  error: "error",
  serviceRestart: "service.restart"
};
var protocolErrorCodes = {
  invalidEnvelope: "invalid_envelope",
  unsupportedVersion: "unsupported_version",
  unsupportedType: "unsupported_type",
  duplicateCorrelation: "duplicate_correlation",
  messageTooLarge: "message_too_large",
  fragmentedMessageRejected: "fragmented_message_rejected",
  unauthorized: "unauthorized",
  queueSaturated: "queue_saturated",
  serviceDraining: "service_draining",
  internalError: "internal_error"
};
var closeCodes = {
  normal: 1e3,
  serviceRestart: 1012,
  authenticationExpired: 4003,
  slowConsumer: 4008,
  heartbeatTimeout: 4009
};
var clientTypes = /* @__PURE__ */ new Set([
  messageTypes.ping,
  messageTypes.subscribe,
  messageTypes.unsubscribe,
  messageTypes.publish
]);
var serverTypes = /* @__PURE__ */ new Set([
  messageTypes.acknowledge,
  messageTypes.event,
  messageTypes.error,
  messageTypes.ping,
  messageTypes.serviceRestart
]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasEnvelopeStrings(value) {
  return typeof value.correlationId === "string" && value.correlationId.trim().length > 0 && value.correlationId.length <= 128 && typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) && typeof value.route === "string" && value.route.trim().length > 0 && value.route.length <= 256;
}
function validateClientEnvelope(value, now = /* @__PURE__ */ new Date()) {
  if (!isRecord(value) || !hasEnvelopeStrings(value)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The message envelope is invalid." };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedVersion, message: "The protocol version is not supported." };
  }
  if (typeof value.type !== "string" || !clientTypes.has(value.type)) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedType, message: "The client message type is not supported." };
  }
  const timestamp = Date.parse(value.timestamp);
  if (timestamp < now.getTime() - 5 * 6e4 || timestamp > now.getTime() + 6e4) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Timestamp is outside the accepted clock-skew window." };
  }
  if (value.type === messageTypes.publish && (value.payload === null || value.payload === void 0)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Publish payload is required." };
  }
  return { valid: true, value };
}
function validateServerEnvelope(value) {
  if (!isRecord(value) || !hasEnvelopeStrings(value)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The server message envelope is invalid." };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedVersion, message: "The protocol version is not supported." };
  }
  if (typeof value.type !== "string" || !serverTypes.has(value.type)) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedType, message: "The server message type is not supported." };
  }
  if (value.type === messageTypes.error && (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The error payload is invalid." };
  }
  return { valid: true, value };
}
function createEnvelope(type, route, payload, correlationId = crypto.randomUUID()) {
  const envelope = {
    version: PROTOCOL_VERSION,
    type,
    correlationId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    route,
    ...payload === void 0 ? {} : { payload }
  };
  const validation = validateClientEnvelope(envelope);
  if (!validation.valid) {
    throw new TypeError(validation.message);
  }
  return envelope;
}

// src/errors.ts
var RealtimeError = class _RealtimeError extends Error {
  code;
  correlationId;
  constructor(message, code, correlationId) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
    if (correlationId !== void 0) {
      this.correlationId = correlationId;
    }
  }
  static fromEnvelope(envelope) {
    const error = envelope.error ?? {
      code: "invalid_envelope",
      message: "The server returned an invalid error envelope."
    };
    return new _RealtimeError(error.message, error.code, envelope.correlationId);
  }
};
var RealtimeConnectionError = class extends RealtimeError {
  constructor(message, code = "connection_failed") {
    super(message, code);
    this.name = "RealtimeConnectionError";
  }
};
var RealtimeQueueError = class extends RealtimeError {
  constructor() {
    super("The bounded client command queue is full.", "queue_saturated");
    this.name = "RealtimeQueueError";
  }
};

// src/client.ts
var OPEN = 1;
var CONNECTING = 0;
var defaultReconnect = {
  enabled: true,
  initialDelayMilliseconds: 500,
  maximumDelayMilliseconds: 3e4,
  jitterRatio: 0.2,
  maximumAttempts: 12
};
var RealtimeClient = class {
  options;
  reconnectOptions;
  listeners = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  queued = [];
  subscriptions = /* @__PURE__ */ new Map();
  subscriptionCommands = /* @__PURE__ */ new Map();
  socket;
  stateValue = "idle";
  connectPromise;
  reconnectTimer;
  heartbeatTimer;
  reconnectAttempt = 0;
  generation = 0;
  intentionalClose = false;
  serverReconnectAdvice;
  constructor(options) {
    if (options.url.toString().trim().length === 0) {
      throw new TypeError("A WebSocket URL is required.");
    }
    this.options = {
      maximumQueuedCommands: 128,
      maximumPendingCommands: 128,
      commandTimeoutMilliseconds: 1e4,
      heartbeatIntervalMilliseconds: 15e3,
      maximumMessageBytes: 16 * 1024,
      ...options
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
  get state() {
    return this.stateValue;
  }
  get desiredSubscriptions() {
    return [...this.subscriptions.keys()];
  }
  on(type, listener) {
    let listeners = this.listeners.get(type);
    if (listeners === void 0) {
      listeners = /* @__PURE__ */ new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }
  async connect(signal) {
    if (this.stateValue === "open") {
      return;
    }
    if (this.connectPromise !== void 0) {
      return this.connectPromise;
    }
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.connectPromise = this.openSocket(signal, false).catch((error) => {
      this.setState("closed");
      this.rejectQueued(error instanceof Error ? error : this.normalizeError(error));
      throw error;
    }).finally(() => {
      this.connectPromise = void 0;
    });
    return this.connectPromise;
  }
  async disconnect(code = closeCodes.normal, reason = "client_disconnect") {
    if (!Number.isInteger(code) || code !== closeCodes.normal && (code < 3e3 || code > 4999)) {
      throw new RangeError("The WebSocket close code must be 1000 or between 3000 and 4999.");
    }
    if (new TextEncoder().encode(reason).byteLength > 123) {
      throw new RangeError("The WebSocket close reason must not exceed 123 UTF-8 bytes.");
    }
    this.intentionalClose = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.setState("closing");
    this.rejectPending(new RealtimeConnectionError("The client disconnected.", "client_disconnect"));
    this.rejectQueued(new RealtimeConnectionError("The client disconnected.", "client_disconnect"));
    const socket = this.socket;
    this.socket = void 0;
    if (socket !== void 0 && (socket.readyState === OPEN || socket.readyState === CONNECTING)) {
      socket.close(code, reason);
    }
    this.setState("closed");
  }
  publish(route, payload, signal) {
    return this.sendCommand(createEnvelope(messageTypes.publish, route, payload), signal);
  }
  async subscribe(route, listener, signal) {
    let routeListeners = this.subscriptions.get(route);
    const isNewRoute = routeListeners === void 0;
    if (routeListeners === void 0) {
      routeListeners = /* @__PURE__ */ new Set();
      this.subscriptions.set(route, routeListeners);
    }
    routeListeners.add(listener);
    try {
      let subscriptionCommand = this.subscriptionCommands.get(route);
      if (isNewRoute) {
        subscriptionCommand = this.establishSubscription(route, signal);
      }
      await subscriptionCommand;
    } catch (error) {
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
      if (current !== void 0 && current.size === 0) {
        this.subscriptions.delete(route);
        if (this.stateValue === "open") {
          await this.sendCommand(createEnvelope(messageTypes.unsubscribe, route));
        }
      }
    };
  }
  ping(signal) {
    return this.sendCommand(createEnvelope(messageTypes.ping, "system/heartbeat"), signal);
  }
  async openSocket(signal, reconnecting) {
    signal?.throwIfAborted();
    const generation = ++this.generation;
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const connectionUrl = await this.createConnectionUrl(signal);
    signal?.throwIfAborted();
    if (generation !== this.generation || this.intentionalClose) {
      throw new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded");
    }
    const factory = this.options.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol));
    const socket = factory(connectionUrl, WEBSOCKET_SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise((resolve, reject) => {
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
        this.serverReconnectAdvice = void 0;
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
  async createConnectionUrl(signal) {
    const url = new URL(this.options.url.toString(), globalThis.location?.href);
    const authentication = this.options.authentication ?? { kind: "session" };
    if (authentication.kind === "ticket") {
      const ticketBaseUrl = new URL(url);
      if (ticketBaseUrl.protocol === "ws:") {
        ticketBaseUrl.protocol = "http:";
      } else if (ticketBaseUrl.protocol === "wss:") {
        ticketBaseUrl.protocol = "https:";
      }
      const endpoint = new URL(authentication.endpoint?.toString() ?? "/realtime/tickets", ticketBaseUrl);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new TypeError("The ticket endpoint must use http or https.");
      }
      const fetcher = authentication.fetch ?? globalThis.fetch;
      if (fetcher === void 0) {
        throw new RealtimeConnectionError("Ticket authentication requires the Fetch API.", "ticket_unavailable");
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
        ...signal === void 0 ? {} : { signal }
      });
      if (!response.ok) {
        throw new RealtimeConnectionError(`Connection ticket request failed (${response.status}).`, "ticket_rejected");
      }
      const value = await response.json();
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
  sendCommand(envelope, signal) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("The command was cancelled.", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === OPEN && this.stateValue === "open") {
        this.transmit({ envelope, resolve, reject, ...signal === void 0 ? {} : { signal } });
        return;
      }
      if (this.queued.length >= this.options.maximumQueuedCommands) {
        reject(new RealtimeQueueError());
        return;
      }
      const command = { envelope, resolve, reject, ...signal === void 0 ? {} : { signal } };
      if (signal !== void 0) {
        const abort = () => this.failQueuedCommand(command, this.abortError(signal));
        signal.addEventListener("abort", abort, { once: true });
        command.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.queued.push(command);
      if (this.stateValue === "idle" || this.stateValue === "closed") {
        void this.connect().catch((error) => {
          const normalized = this.normalizeError(error);
          this.emit("error", normalized);
        });
      }
    });
  }
  transmit(command) {
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
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(correlationId);
      removeAbortListener();
      command.reject(this.normalizeError(error));
    }
  }
  handleMessage(event) {
    if (typeof event.data !== "string") {
      this.emit("error", new RealtimeError("The server sent a non-text message.", "invalid_message_type"));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      this.emit("error", new RealtimeError("The server sent malformed JSON.", "invalid_envelope"));
      return;
    }
    const validation = validateServerEnvelope(parsed);
    if (!validation.valid || validation.value === void 0) {
      this.emit("error", new RealtimeError(validation.message ?? "The server envelope was invalid.", validation.errorCode ?? "invalid_envelope"));
      return;
    }
    const envelope = validation.value;
    if (envelope.type === messageTypes.serviceRestart) {
      if (envelope.reconnect !== null && envelope.reconnect !== void 0) {
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
    if (pending === void 0) {
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
  handleClose(event, generation) {
    if (generation !== this.generation) {
      return;
    }
    this.stopHeartbeat();
    this.socket = void 0;
    const expected = this.intentionalClose || event.code === closeCodes.normal;
    this.rejectPending(new RealtimeConnectionError(`The WebSocket closed (${event.code}).`, "connection_closed"));
    this.emit("close", { code: event.code, reason: event.reason, expected });
    if (expected || !this.reconnectOptions.enabled) {
      this.setState("closed");
      return;
    }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.reconnectTimer !== void 0 || this.intentionalClose || this.socket?.readyState === OPEN) {
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
    const exponential = Math.min(maximum, initial * 2 ** this.reconnectAttempt);
    const random = this.options.random?.() ?? Math.random();
    const delay = Math.max(0, Math.round(exponential * (1 - jitter + 2 * jitter * random)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      void this.openSocket(void 0, true).catch((error) => {
        this.emit("error", this.normalizeError(error));
        this.scheduleReconnect();
      });
    }, delay);
  }
  async restoreSubscriptionsAndFlush() {
    try {
      const queuedSubscriptions = new Set(this.queued.filter((command) => command.envelope.type === messageTypes.subscribe).map((command) => command.envelope.route));
      for (const route of this.subscriptions.keys()) {
        if (!queuedSubscriptions.has(route)) {
          await this.establishSubscription(route);
        }
      }
    } catch (error) {
      this.emit("error", this.normalizeError(error));
    } finally {
      while (this.queued.length > 0 && this.stateValue === "open") {
        const command = this.queued.shift();
        if (command !== void 0) {
          this.transmit(command);
        }
      }
    }
  }
  async establishSubscription(route, signal) {
    const existing = this.subscriptionCommands.get(route);
    if (existing !== void 0) {
      return existing;
    }
    const command = this.sendCommand(createEnvelope(messageTypes.subscribe, route), signal).then(() => void 0);
    this.subscriptionCommands.set(route, command);
    try {
      await command;
    } finally {
      if (this.subscriptionCommands.get(route) === command) {
        this.subscriptionCommands.delete(route);
      }
    }
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.ping().catch((error) => {
        this.emit("error", this.normalizeError(error));
        this.socket?.close(closeCodes.heartbeatTimeout, "heartbeat_failed");
      });
    }, this.options.heartbeatIntervalMilliseconds);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer !== void 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = void 0;
    }
  }
  clearReconnectTimer() {
    if (this.reconnectTimer !== void 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pending.clear();
  }
  rejectQueued(error) {
    for (const command of this.queued.splice(0)) {
      command.removeAbortListener?.();
      command.reject(error);
    }
  }
  failQueuedCommand(command, error) {
    const index = this.queued.indexOf(command);
    if (index >= 0) {
      this.queued.splice(index, 1);
      command.removeAbortListener?.();
      command.reject(error instanceof Error ? error : this.normalizeError(error));
    }
  }
  addPendingAbortListener(command, correlationId) {
    const signal = command.signal;
    if (signal === void 0) {
      return () => void 0;
    }
    const abort = () => {
      const pending = this.pending.get(correlationId);
      if (pending !== void 0 && this.pending.delete(correlationId)) {
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        command.reject(this.abortError(signal));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }
  abortError(signal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("The command was cancelled.", "AbortError");
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
  setState(state) {
    if (this.stateValue !== state) {
      this.stateValue = state;
      this.emit("state", state);
    }
  }
  normalizeError(error) {
    return error instanceof RealtimeError ? error : new RealtimeConnectionError(error instanceof Error ? error.message : "The realtime operation failed.");
  }
  isTicketResponse(value) {
    return typeof value === "object" && value !== null && "ticket" in value && typeof value.ticket === "string" && value.ticket.length >= 32 && "expiresAt" in value && typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt));
  }
  assertPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer.`);
    }
  }
};
export {
  PROTOCOL_VERSION,
  RealtimeClient,
  RealtimeConnectionError,
  RealtimeError,
  RealtimeQueueError,
  SDK_VERSION,
  WEBSOCKET_SUBPROTOCOL,
  closeCodes,
  createEnvelope,
  messageTypes,
  protocolErrorCodes,
  validateClientEnvelope,
  validateServerEnvelope
};
//# sourceMappingURL=cormier-realtime.js.map
