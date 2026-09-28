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

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function event(type: string): Event {
  return { type } as Event;
}

function closeEvent(code: number, reason: string, wasClean: boolean): CloseEvent {
  return { type: "close", code, reason, wasClean } as CloseEvent;
}

export function createTransportSocket(
  websocketUrl: string,
  protocol: string,
  options: RealtimeTransportOptions,
  nextConnectionUrl?: () => Promise<string>,
): WebSocketLike {
  const transports = options.transports ?? ["websocket"];
  if (transports.length === 0) throw new TypeError("At least one transport is required.");
  const factories = transports.map((transport) => (candidateUrl: string) => {
    if (transport === "websocket") {
      return (options.webSocketFactory ?? ((url, selectedProtocol) => new WebSocket(url, selectedProtocol)))(
        candidateUrl,
        protocol,
      );
    }
    const configuration = options.httpStreaming;
    if (configuration === undefined) {
      throw new TypeError("httpStreaming is required when the http-streaming transport is selected.");
    }
    return new HttpStreamingSocket(candidateUrl, configuration);
  });
  return factories.length === 1
    ? factories[0]!(websocketUrl)
    : new InitializingFallbackSocket(websocketUrl, factories, nextConnectionUrl);
}

class InitializingFallbackSocket implements WebSocketLike {
  public binaryType: BinaryType = "arraybuffer";
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  private socket: WebSocketLike | undefined;
  private index = 0;
  private state = CONNECTING;
  private opened = false;

  public constructor(
    private readonly initialUrl: string,
    private readonly factories: readonly ((url: string) => WebSocketLike)[],
    private readonly nextConnectionUrl?: () => Promise<string>,
  ) {
    queueMicrotask(() => void this.tryNext());
  }

  public get readyState(): number {
    return this.state;
  }

  public get transport(): RealtimeTransport | undefined {
    return this.socket?.transport ?? (this.opened ? "websocket" : undefined);
  }

  public send(data: string): void {
    if (!this.opened || this.socket === undefined) throw new DOMException("The connection is not open.", "InvalidStateError");
    this.socket.send(data);
  }

  public close(code?: number, reason?: string): void {
    this.state = CLOSING;
    this.socket?.close(code, reason);
    if (this.socket === undefined) {
      this.state = CLOSED;
      this.onclose?.(closeEvent(code ?? 1000, reason ?? "", true));
    }
  }

  private async tryNext(): Promise<void> {
    if (this.state !== CONNECTING) return;
    let candidate: WebSocketLike;
    try {
      const url = this.index === 0 || this.nextConnectionUrl === undefined
        ? this.initialUrl
        : await this.nextConnectionUrl();
      if (this.state !== CONNECTING) return;
      candidate = this.factories[this.index]!(url);
    } catch {
      this.advance();
      return;
    }
    candidate.binaryType = this.binaryType;
    this.socket = candidate;
    candidate.onopen = (opened) => {
      this.opened = true;
      this.state = OPEN;
      this.onopen?.(opened);
    };
    candidate.onmessage = (message) => this.onmessage?.(message);
    candidate.onerror = (failure) => {
      if (this.opened) {
        this.onerror?.(failure);
      } else if (this.state === CONNECTING) {
        candidate.onclose = null;
        candidate.close();
        this.advance();
      }
    };
    candidate.onclose = (closed) => {
      if (!this.opened && this.state === CONNECTING) {
        this.advance();
        return;
      }
      this.state = CLOSED;
      this.onclose?.(closed);
    };
  }

  private advance(): void {
    if (this.state !== CONNECTING) return;
    this.socket = undefined;
    this.index += 1;
    if (this.index < this.factories.length) {
      queueMicrotask(() => void this.tryNext());
      return;
    }
    this.state = CLOSED;
    this.onerror?.(event("error"));
    this.onclose?.(closeEvent(1006, "transport_initialization_failed", false));
  }
}

class HttpStreamingSocket implements WebSocketLike {
  public readonly transport = "http-streaming" as const;
  public binaryType: BinaryType = "arraybuffer";
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  private state = CONNECTING;
  private readonly controller = new AbortController();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: URL;
  private connectionId: string | undefined;
  private connectionToken: string | undefined;
  private sendTail: Promise<void> = Promise.resolve();

  public constructor(websocketUrl: string, options: HttpStreamingOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (this.fetcher === undefined) throw new TypeError("HTTP streaming requires the Fetch API.");
    this.baseUrl = new URL(options.url.toString(), globalThis.location?.href);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new TypeError("The HTTP streaming URL must use http or https.");
    }
    const source = new URL(websocketUrl, globalThis.location?.href);
    for (const name of ["ticket", "reconnect"]) {
      const value = source.searchParams.get(name);
      if (value !== null) this.baseUrl.searchParams.set(name, value);
    }
    queueMicrotask(() => void this.start());
  }

  public get readyState(): number {
    return this.state;
  }

  public send(data: string): void {
    if (this.state !== OPEN || this.connectionId === undefined || this.connectionToken === undefined) {
      throw new DOMException("The connection is not open.", "InvalidStateError");
    }
    const id = this.connectionId;
    const token = this.connectionToken;
    this.sendTail = this.sendTail.then(async () => {
      const response = await this.fetcher(this.connectionUrl(id, "messages"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Cormier-Connection": token },
        body: data,
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP streaming send failed (${response.status}).`);
    }).catch(() => this.fail("send_failed"));
  }

  public close(code = 1000, reason = ""): void {
    if (this.state >= CLOSING) return;
    this.state = CLOSING;
    const id = this.connectionId;
    const token = this.connectionToken;
    if (id !== undefined && token !== undefined) {
      void this.fetcher(this.connectionUrl(id), {
        method: "DELETE",
        credentials: "include",
        headers: { "X-Cormier-Connection": token },
        keepalive: true,
      }).catch(() => undefined);
    }
    this.controller.abort();
    this.state = CLOSED;
    this.onclose?.(closeEvent(code, reason, true));
  }

  private async start(): Promise<void> {
    try {
      const connectUrl = new URL(this.baseUrl);
      connectUrl.pathname = `${connectUrl.pathname.replace(/\/$/u, "")}/connect`;
      const response = await this.fetcher(connectUrl, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP streaming connection failed (${response.status}).`);
      const value: unknown = await response.json();
      if (!this.isConnectionResponse(value)) throw new Error("HTTP streaming connection response was invalid.");
      this.connectionId = value.connectionId;
      this.connectionToken = value.connectionToken;
      this.state = OPEN;
      this.onopen?.(event("open"));
      await this.poll();
    } catch (error: unknown) {
      if (!this.controller.signal.aborted) this.fail(error instanceof Error ? error.message : "connection_failed");
    }
  }

  private async poll(): Promise<void> {
    while (this.state === OPEN && this.connectionId !== undefined && this.connectionToken !== undefined) {
      const response = await this.fetcher(this.connectionUrl(this.connectionId, "poll"), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "X-Cormier-Connection": this.connectionToken },
        signal: this.controller.signal,
      });
      if (response.status === 204) continue;
      if (!response.ok) throw new Error(`HTTP fallback poll failed (${response.status}).`);
      const message = await response.text();
      if (message.length > 0) this.onmessage?.({ type: "message", data: message } as MessageEvent);
    }
  }

  private connectionUrl(id: string, suffix?: string): URL {
    const url = new URL(this.baseUrl);
    url.search = "";
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/connections/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`;
    return url;
  }

  private fail(reason: string): void {
    if (this.state === CLOSED) return;
    this.onerror?.(event("error"));
    this.controller.abort();
    this.state = CLOSED;
    this.onclose?.(closeEvent(1006, reason, false));
  }

  private isConnectionResponse(value: unknown): value is { connectionId: string; connectionToken: string } {
    return typeof value === "object" && value !== null
      && typeof (value as { connectionId?: unknown }).connectionId === "string"
      && typeof (value as { connectionToken?: unknown }).connectionToken === "string";
  }
}
