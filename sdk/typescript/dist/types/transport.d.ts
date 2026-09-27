export interface WebSocketLike {
    readonly readyState: number;
    readonly transport?: RealtimeTransport | undefined;
    binaryType: BinaryType;
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
export type RealtimeTransport = "websocket" | "http-streaming";
export interface HttpStreamingOptions {
    readonly url: string | URL;
    readonly fetch?: typeof globalThis.fetch;
}
export interface RealtimeTransportOptions {
    readonly transports?: readonly RealtimeTransport[];
    readonly httpStreaming?: HttpStreamingOptions;
    readonly webSocketFactory?: (url: string, protocol: string) => WebSocketLike;
}
export declare function createTransportSocket(websocketUrl: string, protocol: string, options: RealtimeTransportOptions): WebSocketLike;
//# sourceMappingURL=transport.d.ts.map