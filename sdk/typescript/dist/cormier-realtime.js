// src/protocol.ts
var SDK_VERSION = "1.0.2-beta";
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
var maximumTimerDelayMilliseconds = 2147483647;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonValue(value, ancestors = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value) ? value.every((item) => isJsonValue(item, ancestors)) : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
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
  if ("payload" in value && value.payload !== void 0 && !isJsonValue(value.payload)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Payload must contain only finite JSON values." };
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
  if ("payload" in value && value.payload !== void 0 && !isJsonValue(value.payload)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Payload must contain only finite JSON values." };
  }
  if (value.type === messageTypes.error && (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The error payload is invalid." };
  }
  if (value.type === messageTypes.serviceRestart && value.reconnect !== null && value.reconnect !== void 0) {
    if (!isRecord(value.reconnect) || typeof value.reconnect.initialDelayMilliseconds !== "number" || !Number.isSafeInteger(value.reconnect.initialDelayMilliseconds) || value.reconnect.initialDelayMilliseconds < 0 || value.reconnect.initialDelayMilliseconds > maximumTimerDelayMilliseconds || typeof value.reconnect.maximumDelayMilliseconds !== "number" || !Number.isSafeInteger(value.reconnect.maximumDelayMilliseconds) || value.reconnect.maximumDelayMilliseconds < value.reconnect.initialDelayMilliseconds || value.reconnect.maximumDelayMilliseconds > maximumTimerDelayMilliseconds || typeof value.reconnect.jitterRatio !== "number" || !Number.isFinite(value.reconnect.jitterRatio) || value.reconnect.jitterRatio < 0 || value.reconnect.jitterRatio > 1 || typeof value.reconnect.reauthenticate !== "boolean") {
      return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The reconnect advice is invalid." };
    }
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
  connectAbortController;
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
    const configuredUrl = new URL(options.url.toString(), "http://localhost");
    if ([...configuredUrl.searchParams.keys()].some((key) => key.toLowerCase() === "reconnect")) {
      throw new TypeError("The realtime URL must not contain the reserved reconnect query parameter.");
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
    this.assertNonNegativeInteger(this.reconnectOptions.initialDelayMilliseconds, "reconnect.initialDelayMilliseconds");
    this.assertNonNegativeInteger(this.reconnectOptions.maximumDelayMilliseconds, "reconnect.maximumDelayMilliseconds");
    if (this.reconnectOptions.maximumDelayMilliseconds < this.reconnectOptions.initialDelayMilliseconds) {
      throw new RangeError("reconnect.maximumDelayMilliseconds must not be less than reconnect.initialDelayMilliseconds.");
    }
    if (!Number.isFinite(this.reconnectOptions.jitterRatio) || this.reconnectOptions.jitterRatio < 0 || this.reconnectOptions.jitterRatio > 1) {
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
    if (this.stateValue === "open" && this.socket?.readyState === OPEN) {
      return;
    }
    if (this.connectPromise !== void 0) {
      return this.connectPromise;
    }
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.connectAbortController?.abort(new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded"));
    const controller = new AbortController();
    this.connectAbortController = controller;
    const connectionSignal = signal === void 0 ? controller.signal : AbortSignal.any([signal, controller.signal]);
    let connection;
    connection = this.openSocket(connectionSignal, false).catch((error) => {
      if (this.connectPromise === connection) {
        this.setState("closed");
        this.rejectQueued(error instanceof Error ? error : this.normalizeError(error));
      }
      throw error;
    }).finally(() => {
      if (this.connectPromise === connection) {
        this.connectPromise = void 0;
      }
      if (this.connectAbortController === controller) {
        this.connectAbortController = void 0;
      }
    });
    this.connectPromise = connection;
    return connection;
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
    this.connectAbortController?.abort(new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded"));
    this.connectAbortController = void 0;
    this.connectPromise = void 0;
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
    const registration = { listener };
    routeListeners.add(registration);
    try {
      let subscriptionCommand = this.subscriptionCommands.get(route);
      if (isNewRoute) {
        subscriptionCommand = this.establishSubscription(route);
      }
      await this.waitForSubscription(subscriptionCommand, signal);
    } catch (error) {
      routeListeners.delete(registration);
      if (routeListeners.size === 0) {
        this.subscriptions.delete(route);
      }
      throw error;
    }
    let active = true;
    let unsubscribePromise;
    return () => {
      if (!active) {
        return Promise.resolve();
      }
      if (unsubscribePromise === void 0) {
        unsubscribePromise = (async () => {
          const current = this.subscriptions.get(route);
          current?.delete(registration);
          if (current !== void 0 && current.size === 0) {
            this.subscriptions.delete(route);
            if (this.stateValue === "open") {
              try {
                await this.sendCommand(createEnvelope(messageTypes.unsubscribe, route));
              } catch (error) {
                current.add(registration);
                this.subscriptions.set(route, current);
                this.socket?.close(4e3, "unsubscribe_failed");
                throw error;
              }
            }
          }
          active = false;
        })().finally(() => {
          unsubscribePromise = void 0;
        });
      }
      return unsubscribePromise;
    };
  }
  ping(signal) {
    return this.sendCommand(createEnvelope(messageTypes.ping, "system/heartbeat"), signal);
  }
  async openSocket(signal, reconnecting) {
    signal?.throwIfAborted();
    const generation = ++this.generation;
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const connectionUrl = await this.createConnectionUrl(reconnecting, signal);
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
      let connectionEstablished = false;
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
        signal?.removeEventListener("abort", abort);
        void this.restoreSubscriptionsAndFlush(generation).then(() => {
          if (generation !== this.generation || this.intentionalClose) {
            throw new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded");
          }
          this.reconnectAttempt = 0;
          this.serverReconnectAdvice = void 0;
          connectionEstablished = true;
          this.setState("open");
          if (generation !== this.generation || this.intentionalClose || socket.readyState !== OPEN) {
            throw new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded");
          }
          this.startHeartbeat();
          settled = true;
          resolve();
        }).catch((error) => {
          if (!settled) {
            settled = true;
            const normalized = this.normalizeError(error);
            this.rejectQueued(normalized);
            reject(normalized);
            if (socket.readyState === OPEN) {
              socket.close(4e3, "subscription_restore_failed");
            }
          }
        });
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
        this.handleClose(event, generation, connectionEstablished || reconnecting);
      };
    });
  }
  async createConnectionUrl(reconnecting, signal) {
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
      const response = await this.waitForAbort(fetcher(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
        ...signal === void 0 ? {} : { signal }
      }), signal);
      if (!response.ok) {
        throw new RealtimeConnectionError(`Connection ticket request failed (${response.status}).`, "ticket_rejected");
      }
      const value = await this.waitForAbort(response.json(), signal);
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
    if (reconnecting) {
      url.searchParams.set("reconnect", "true");
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
  transmit(command, queueWhenUnavailable = true) {
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
      if (!queueWhenUnavailable) {
        command.reject(new RealtimeConnectionError("The connection closed before the command could be sent.", "connection_closed"));
      } else if (this.queued.length >= this.options.maximumQueuedCommands) {
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
      if (this.socket === socket) {
        socket.close(closeCodes.heartbeatTimeout, "send_failed");
      }
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
      for (const registration of this.subscriptions.get(envelope.route) ?? []) {
        this.invokeListener(registration.listener, envelope);
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
  handleClose(event, generation, allowReconnect) {
    if (generation !== this.generation) {
      return;
    }
    this.stopHeartbeat();
    this.socket = void 0;
    const expected = this.intentionalClose || event.code === closeCodes.normal;
    this.rejectPending(new RealtimeConnectionError(`The WebSocket closed (${event.code}).`, "connection_closed"));
    this.setState("closed");
    this.emit("close", { code: event.code, reason: event.reason, expected });
    if (expected || !allowReconnect || !this.reconnectOptions.enabled || generation !== this.generation) {
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
    const exponentialBase = initial === 0 ? 1 : initial;
    const attemptDelay = this.reconnectAttempt === 0 ? initial : exponentialBase * 2 ** (this.reconnectAttempt - 1);
    const exponential = Math.min(maximum, attemptDelay);
    const random = this.options.random?.() ?? Math.random();
    const delay = Math.max(0, Math.round(exponential * (1 - jitter + 2 * jitter * random)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      const controller = new AbortController();
      this.connectAbortController?.abort(new RealtimeConnectionError("The connection attempt was superseded.", "connection_superseded"));
      this.connectAbortController = controller;
      void this.openSocket(controller.signal, true).catch((error) => {
        const normalized = this.normalizeError(error);
        if (normalized.code !== "connection_superseded") {
          this.emit("error", normalized);
          this.scheduleReconnect();
        }
      }).finally(() => {
        if (this.connectAbortController === controller) {
          this.connectAbortController = void 0;
        }
      });
    }, delay);
  }
  async restoreSubscriptionsAndFlush(generation) {
    const queuedSubscriptions = /* @__PURE__ */ new Map();
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const command = this.queued[index];
      if (command?.envelope.type === messageTypes.subscribe) {
        this.queued.splice(index, 1);
        queuedSubscriptions.set(command.envelope.route, command);
      }
    }
    const routes = /* @__PURE__ */ new Set([...this.subscriptions.keys(), ...queuedSubscriptions.keys()]);
    const failures = [];
    for (const route of routes) {
      try {
        this.assertOpenGeneration(generation);
        const queued = queuedSubscriptions.get(route);
        if (queued === void 0) {
          await this.transmitEnvelope(createEnvelope(messageTypes.subscribe, route), false);
        } else {
          await this.transmitQueuedCommand(queued, false);
        }
        if (!this.subscriptions.has(route)) {
          this.assertOpenGeneration(generation);
          await this.transmitEnvelope(createEnvelope(messageTypes.unsubscribe, route), false);
        }
      } catch (error) {
        const normalized = this.normalizeError(error);
        failures.push(normalized);
        this.emit("error", normalized);
      }
    }
    if (failures.length > 0) {
      throw new RealtimeConnectionError("One or more subscriptions could not be restored.", "subscription_restore_failed");
    }
    this.assertOpenGeneration(generation);
    while (this.queued.length > 0) {
      const command = this.queued.shift();
      if (command !== void 0) {
        this.transmit(command);
      }
    }
  }
  async establishSubscription(route) {
    const existing = this.subscriptionCommands.get(route);
    if (existing !== void 0) {
      return existing;
    }
    const command = this.sendCommand(createEnvelope(messageTypes.subscribe, route)).then(() => void 0);
    this.subscriptionCommands.set(route, command);
    try {
      await command;
      if (!this.subscriptions.has(route) && this.stateValue === "open") {
        await this.sendCommand(createEnvelope(messageTypes.unsubscribe, route));
      }
    } finally {
      if (this.subscriptionCommands.get(route) === command) {
        this.subscriptionCommands.delete(route);
      }
    }
  }
  transmitQueuedCommand(command, queueWhenUnavailable = true) {
    return new Promise((resolve, reject) => {
      this.transmit({
        ...command,
        resolve: (envelope) => {
          command.resolve(envelope);
          resolve(envelope);
        },
        reject: (error) => {
          command.reject(error);
          reject(error);
        }
      }, queueWhenUnavailable);
    });
  }
  transmitEnvelope(envelope, queueWhenUnavailable = true) {
    return new Promise((resolve, reject) => {
      this.transmit({ envelope, resolve, reject }, queueWhenUnavailable);
    });
  }
  assertOpenGeneration(generation) {
    if (generation !== this.generation || this.socket?.readyState !== OPEN) {
      throw new RealtimeConnectionError("The connection closed during subscription restoration.", "connection_closed");
    }
  }
  async waitForAbort(operation, signal) {
    signal?.throwIfAborted();
    if (signal === void 0) {
      return operation;
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(this.abortError(signal));
      signal.addEventListener("abort", abort, { once: true });
      void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async waitForSubscription(command, signal) {
    if (command === void 0) {
      return;
    }
    signal?.throwIfAborted();
    if (signal === void 0) {
      return command;
    }
    await new Promise((resolve, reject) => {
      const abort = () => reject(this.abortError(signal));
      signal.addEventListener("abort", abort, { once: true });
      void command.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
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
      this.invokeListener(listener, event);
    }
  }
  invokeListener(listener, event) {
    try {
      listener(event);
    } catch {
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
  assertNonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      throw new RangeError(`${name} must be a nonnegative timer-safe integer.`);
    }
  }
};

// src/diagnostics.ts
var DiagnosticsClient = class {
  #baseUrl;
  #headers;
  #fetch;
  #onStreamError;
  #streamRetryMilliseconds;
  constructor(options = {}) {
    this.#baseUrl = (options.baseUrl ?? "/diagnostics/v1").replace(/\/$/, "");
    this.#headers = { ...options.headers ?? {} };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#onStreamError = options.onStreamError ?? (() => void 0);
    this.#streamRetryMilliseconds = options.streamRetryMilliseconds ?? 1e3;
    if (!Number.isSafeInteger(this.#streamRetryMilliseconds) || this.#streamRetryMilliseconds < 100 || this.#streamRetryMilliseconds > 6e4) {
      throw new RangeError("streamRetryMilliseconds must be between 100 and 60000.");
    }
  }
  snapshot(signal) {
    return this.#request("/snapshot", signal ? { signal } : {});
  }
  activeLogLevels(signal) {
    return this.#request("/logging/overrides", signal ? { signal } : {});
  }
  audit(offset = 0, limit = 25, signal) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.#request(`/logging/audit?${query}`, signal ? { signal } : {});
  }
  applyLogLevel(change, signal) {
    return this.#request("/logging/overrides", {
      method: "POST",
      ...signal ? { signal } : {},
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...change, scope: change.scope ?? "all" })
    });
  }
  async revertLogLevel(id, signal) {
    await this.#request(`/logging/overrides/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...signal ? { signal } : {}
    });
  }
  streamEvents(onEvent) {
    return this.#stream("/events", {}, onEvent);
  }
  tailLogs(filter, onEvent) {
    return this.#stream(
      "/logs/tail",
      filter,
      onEvent,
      filter.durationSeconds
    );
  }
  #stream(path, query, onEvent, durationSeconds) {
    const parameters = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== void 0) parameters.set(name, String(value));
    const suffix = parameters.size === 0 ? "" : `?${parameters}`;
    const cancellation = new AbortController();
    const durationTimer = durationSeconds !== void 0 && Number.isFinite(durationSeconds) && durationSeconds > 0 ? setTimeout(() => cancellation.abort(), durationSeconds * 1e3) : void 0;
    void this.#runStream(`${this.#baseUrl}${path}${suffix}`, cancellation, onEvent).finally(() => {
      if (durationTimer !== void 0) clearTimeout(durationTimer);
    });
    return () => {
      if (durationTimer !== void 0) clearTimeout(durationTimer);
      cancellation.abort();
    };
  }
  async #runStream(url, cancellation, onEvent) {
    while (!cancellation.signal.aborted) {
      try {
        if (await this.#consumeStream(url, cancellation, onEvent)) {
          return;
        }
      } catch (error) {
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
  async #consumeStream(url, cancellation, onEvent) {
    const response = await this.#fetch(url, {
      credentials: "same-origin",
      headers: this.#headers,
      signal: cancellation.signal
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
      await reader.cancel().catch(() => void 0);
    }
    return false;
  }
  async #waitForStreamRetry(signal) {
    await new Promise((resolve) => {
      const complete = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", complete);
        resolve();
      };
      const timer = setTimeout(complete, this.#streamRetryMilliseconds);
      signal.addEventListener("abort", complete, { once: true });
    });
  }
  #dispatchStreamBlock(block, onEvent) {
    let eventName = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (eventName === "disconnect") {
      return true;
    }
    if (eventName === "message" && data.length > 0) {
      onEvent(JSON.parse(data.join("\n")));
    }
    return false;
  }
  async #request(path, init = {}) {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { ...this.#headers, ...init.headers ?? {} }
    });
    if (!response.ok) {
      throw new Error(`Diagnostics request failed with HTTP ${response.status}.`);
    }
    return response.status === 204 ? void 0 : await response.json();
  }
};
var DiagnosticsStreamHttpError = class extends Error {
  isPermanent;
  constructor(status) {
    super(`Diagnostics stream failed with HTTP ${status}.`);
    this.name = "DiagnosticsStreamHttpError";
    this.isPermanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
};
export {
  DiagnosticsClient,
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
