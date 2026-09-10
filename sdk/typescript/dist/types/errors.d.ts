import type { ServerMessageEnvelope } from "./protocol.js";
export declare class RealtimeError extends Error {
    readonly code: string;
    readonly correlationId?: string;
    constructor(message: string, code: string, correlationId?: string);
    static fromEnvelope(envelope: ServerMessageEnvelope): RealtimeError;
}
export declare class RealtimeConnectionError extends RealtimeError {
    constructor(message: string, code?: string);
}
export declare class RealtimeQueueError extends RealtimeError {
    constructor();
}
//# sourceMappingURL=errors.d.ts.map