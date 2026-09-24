export const SDK_VERSION = "1.0.1-beta" as const;
export const PROTOCOL_VERSION = "1.0" as const;
export const WEBSOCKET_SUBPROTOCOL = "cormier.realtime.v1" as const;

export const messageTypes = {
  ping: "ping",
  subscribe: "subscribe",
  unsubscribe: "unsubscribe",
  publish: "publish",
  acknowledge: "ack",
  event: "event",
  error: "error",
  serviceRestart: "service.restart",
} as const;

export const protocolErrorCodes = {
  invalidEnvelope: "invalid_envelope",
  unsupportedVersion: "unsupported_version",
  unsupportedType: "unsupported_type",
  duplicateCorrelation: "duplicate_correlation",
  messageTooLarge: "message_too_large",
  fragmentedMessageRejected: "fragmented_message_rejected",
  unauthorized: "unauthorized",
  queueSaturated: "queue_saturated",
  serviceDraining: "service_draining",
  internalError: "internal_error",
} as const;

export const closeCodes = {
  normal: 1000,
  serviceRestart: 1012,
  authenticationExpired: 4003,
  slowConsumer: 4008,
  heartbeatTimeout: 4009,
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type ClientMessageType = "ping" | "subscribe" | "unsubscribe" | "publish";
export type ServerMessageType = "ack" | "event" | "error" | "ping" | "service.restart";
export type ProtocolErrorCode = (typeof protocolErrorCodes)[keyof typeof protocolErrorCodes];

export interface MessageEnvelope<TPayload extends JsonValue = JsonValue> {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: ClientMessageType;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly route: string;
  readonly payload?: TPayload;
}

export interface ProtocolErrorPayload {
  readonly code: string;
  readonly message: string;
}

export interface ReconnectAdvice {
  readonly initialDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly jitterRatio: number;
  readonly reauthenticate: boolean;
}

export interface ServerMessageEnvelope<TPayload extends JsonValue = JsonValue> {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: ServerMessageType;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly route: string;
  readonly payload?: TPayload | null;
  readonly error?: ProtocolErrorPayload | null;
  readonly reconnect?: ReconnectAdvice | null;
  readonly [extension: string]: unknown;
}

export interface ConnectionTicketResponse {
  readonly ticket: string;
  readonly expiresAt: string;
}

export interface ValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly errorCode?: ProtocolErrorCode;
  readonly message?: string;
}

const clientTypes: ReadonlySet<string> = new Set([
  messageTypes.ping,
  messageTypes.subscribe,
  messageTypes.unsubscribe,
  messageTypes.publish,
]);

const serverTypes: ReadonlySet<string> = new Set([
  messageTypes.acknowledge,
  messageTypes.event,
  messageTypes.error,
  messageTypes.ping,
  messageTypes.serviceRestart,
]);
const maximumTimerDelayMilliseconds = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
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
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function hasEnvelopeStrings(value: Record<string, unknown>): boolean {
  return typeof value.correlationId === "string"
    && value.correlationId.trim().length > 0
    && value.correlationId.length <= 128
    && typeof value.timestamp === "string"
    && !Number.isNaN(Date.parse(value.timestamp))
    && typeof value.route === "string"
    && value.route.trim().length > 0
    && value.route.length <= 256;
}

export function validateClientEnvelope(value: unknown, now = new Date()): ValidationResult<MessageEnvelope> {
  if (!isRecord(value) || !hasEnvelopeStrings(value)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The message envelope is invalid." };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedVersion, message: "The protocol version is not supported." };
  }
  if (typeof value.type !== "string" || !clientTypes.has(value.type)) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedType, message: "The client message type is not supported." };
  }
  const timestamp = Date.parse(value.timestamp as string);
  if (timestamp < now.getTime() - (5 * 60_000) || timestamp > now.getTime() + 60_000) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Timestamp is outside the accepted clock-skew window." };
  }
  if (value.type === messageTypes.publish && (value.payload === null || value.payload === undefined)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Publish payload is required." };
  }
  if ("payload" in value && value.payload !== undefined && !isJsonValue(value.payload)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Payload must contain only finite JSON values." };
  }
  return { valid: true, value: value as unknown as MessageEnvelope };
}

export function validateServerEnvelope(value: unknown): ValidationResult<ServerMessageEnvelope> {
  if (!isRecord(value) || !hasEnvelopeStrings(value)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The server message envelope is invalid." };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedVersion, message: "The protocol version is not supported." };
  }
  if (typeof value.type !== "string" || !serverTypes.has(value.type)) {
    return { valid: false, errorCode: protocolErrorCodes.unsupportedType, message: "The server message type is not supported." };
  }
  if ("payload" in value && value.payload !== undefined && !isJsonValue(value.payload)) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "Payload must contain only finite JSON values." };
  }
  if (value.type === messageTypes.error && (!isRecord(value.error)
    || typeof value.error.code !== "string"
    || typeof value.error.message !== "string")) {
    return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The error payload is invalid." };
  }
  if (value.type === messageTypes.serviceRestart && value.reconnect !== null && value.reconnect !== undefined) {
    if (!isRecord(value.reconnect)
      || typeof value.reconnect.initialDelayMilliseconds !== "number"
      || !Number.isSafeInteger(value.reconnect.initialDelayMilliseconds)
      || value.reconnect.initialDelayMilliseconds < 0
      || value.reconnect.initialDelayMilliseconds > maximumTimerDelayMilliseconds
      || typeof value.reconnect.maximumDelayMilliseconds !== "number"
      || !Number.isSafeInteger(value.reconnect.maximumDelayMilliseconds)
      || value.reconnect.maximumDelayMilliseconds < value.reconnect.initialDelayMilliseconds
      || value.reconnect.maximumDelayMilliseconds > maximumTimerDelayMilliseconds
      || typeof value.reconnect.jitterRatio !== "number"
      || !Number.isFinite(value.reconnect.jitterRatio)
      || value.reconnect.jitterRatio < 0
      || value.reconnect.jitterRatio > 1
      || typeof value.reconnect.reauthenticate !== "boolean") {
      return { valid: false, errorCode: protocolErrorCodes.invalidEnvelope, message: "The reconnect advice is invalid." };
    }
  }
  return { valid: true, value: value as unknown as ServerMessageEnvelope };
}

export function createEnvelope<TPayload extends JsonValue>(
  type: ClientMessageType,
  route: string,
  payload?: TPayload,
  correlationId = crypto.randomUUID(),
): MessageEnvelope<TPayload> {
  const envelope: MessageEnvelope<TPayload> = {
    version: PROTOCOL_VERSION,
    type,
    correlationId,
    timestamp: new Date().toISOString(),
    route,
    ...(payload === undefined ? {} : { payload }),
  };
  const validation = validateClientEnvelope(envelope);
  if (!validation.valid) {
    throw new TypeError(validation.message);
  }
  return envelope;
}
