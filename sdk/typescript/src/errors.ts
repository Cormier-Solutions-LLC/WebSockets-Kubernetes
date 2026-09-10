import type { ProtocolErrorPayload, ServerMessageEnvelope } from "./protocol.js";

export class RealtimeError extends Error {
  public readonly code: string;
  public readonly correlationId?: string;

  public constructor(message: string, code: string, correlationId?: string) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
    if (correlationId !== undefined) {
      this.correlationId = correlationId;
    }
  }

  public static fromEnvelope(envelope: ServerMessageEnvelope): RealtimeError {
    const error: ProtocolErrorPayload = envelope.error ?? {
      code: "invalid_envelope",
      message: "The server returned an invalid error envelope.",
    };
    return new RealtimeError(error.message, error.code, envelope.correlationId);
  }
}

export class RealtimeConnectionError extends RealtimeError {
  public constructor(message: string, code = "connection_failed") {
    super(message, code);
    this.name = "RealtimeConnectionError";
  }
}

export class RealtimeQueueError extends RealtimeError {
  public constructor() {
    super("The bounded client command queue is full.", "queue_saturated");
    this.name = "RealtimeQueueError";
  }
}
