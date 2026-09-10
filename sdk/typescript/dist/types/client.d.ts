import { type JsonValue, type ServerMessageEnvelope } from "./protocol.js";
import { RealtimeError } from "./errors.js";
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
export declare class RealtimeClient {
    private readonly options;
    private readonly reconnectOptions;
    private readonly listeners;
    private readonly pending;
    private readonly queued;
    private readonly subscriptions;
    private readonly subscriptionCommands;
    private socket;
    private stateValue;
    private connectPromise;
    private connectAbortController;
    private reconnectTimer;
    private heartbeatTimer;
    private reconnectAttempt;
    private generation;
    private intentionalClose;
    private serverReconnectAdvice;
    constructor(options: RealtimeClientOptions);
    get state(): RealtimeClientState;
    get desiredSubscriptions(): readonly string[];
    on<TKey extends keyof RealtimeClientEvents>(type: TKey, listener: Listener<TKey>): () => void;
    connect(signal?: AbortSignal): Promise<void>;
    disconnect(code?: number, reason?: string): Promise<void>;
    publish<TPayload extends JsonValue>(route: string, payload: TPayload, signal?: AbortSignal): Promise<ServerMessageEnvelope>;
    subscribe(route: string, listener: (event: ServerMessageEnvelope) => void, signal?: AbortSignal): Promise<() => Promise<void>>;
    ping(signal?: AbortSignal): Promise<ServerMessageEnvelope>;
    private openSocket;
    private createConnectionUrl;
    private sendCommand;
    private transmit;
    private handleMessage;
    private handleClose;
    private scheduleReconnect;
    private restoreSubscriptionsAndFlush;
    private establishSubscription;
    private transmitQueuedCommand;
    private transmitEnvelope;
    private assertOpenGeneration;
    private waitForAbort;
    private waitForSubscription;
    private startHeartbeat;
    private stopHeartbeat;
    private clearReconnectTimer;
    private rejectPending;
    private rejectQueued;
    private failQueuedCommand;
    private addPendingAbortListener;
    private abortError;
    private emit;
    private invokeListener;
    private setState;
    private normalizeError;
    private isTicketResponse;
    private assertPositiveInteger;
    private assertNonNegativeInteger;
}
export {};
//# sourceMappingURL=client.d.ts.map