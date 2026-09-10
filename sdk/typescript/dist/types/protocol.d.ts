export declare const SDK_VERSION: "0.1.0";
export declare const PROTOCOL_VERSION: "1.0";
export declare const WEBSOCKET_SUBPROTOCOL: "cormier.realtime.v1";
export declare const messageTypes: {
    readonly ping: "ping";
    readonly subscribe: "subscribe";
    readonly unsubscribe: "unsubscribe";
    readonly publish: "publish";
    readonly acknowledge: "ack";
    readonly event: "event";
    readonly error: "error";
    readonly serviceRestart: "service.restart";
};
export declare const protocolErrorCodes: {
    readonly invalidEnvelope: "invalid_envelope";
    readonly unsupportedVersion: "unsupported_version";
    readonly unsupportedType: "unsupported_type";
    readonly duplicateCorrelation: "duplicate_correlation";
    readonly messageTooLarge: "message_too_large";
    readonly fragmentedMessageRejected: "fragmented_message_rejected";
    readonly unauthorized: "unauthorized";
    readonly queueSaturated: "queue_saturated";
    readonly serviceDraining: "service_draining";
    readonly internalError: "internal_error";
};
export declare const closeCodes: {
    readonly normal: 1000;
    readonly serviceRestart: 1012;
    readonly authenticationExpired: 4003;
    readonly slowConsumer: 4008;
    readonly heartbeatTimeout: 4009;
};
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | {
    readonly [key: string]: JsonValue;
} | readonly JsonValue[];
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
export declare function validateClientEnvelope(value: unknown, now?: Date): ValidationResult<MessageEnvelope>;
export declare function validateServerEnvelope(value: unknown): ValidationResult<ServerMessageEnvelope>;
export declare function createEnvelope<TPayload extends JsonValue>(type: ClientMessageType, route: string, payload?: TPayload, correlationId?: `${string}-${string}-${string}-${string}-${string}`): MessageEnvelope<TPayload>;
//# sourceMappingURL=protocol.d.ts.map