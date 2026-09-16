# Cormier.Realtime TypeScript and browser SDK

`@cormier/realtime` is the typed browser client for wire protocol `1.0`. It supports same-origin HttpOnly session cookies and short-lived, single-use connection tickets without exposing authentication material through callbacks, errors, or library logging.

For an npm consumer, install `@cormier/realtime` from your configured approved registry and import `{ RealtimeClient }` from `@cormier/realtime`. The package is ESM (`type: module`), with declarations at `dist/types/index.d.ts`; it does not provide a CommonJS build. The `@cormier/realtime/browser` export selects the readable IIFE. Direct browser examples below assume the chosen generated file is served at the shown relative URL. An authenticated application session and a compatible gateway must already exist; the SDK does not log users in.

## Operator diagnostics client

`DiagnosticsClient` is an explicit administrative client for the versioned diagnostics API. It is separate from `RealtimeClient`, so ordinary application roles do not invoke operator controls accidentally. Configure an operator-protected base URL and authentication headers, then call `snapshot()`, `activeLogLevels()`, `applyLogLevel()`, or `revertLogLevel()`. `streamEvents()` and `tailLogs()` use a credentialed streaming `fetch`, carry the configured headers, retry ordinary interruptions, and stop when the server sends its bounded `disconnect` event; call the returned function to disconnect manually.

`audit(offset, limit)` reads the paginated logging audit. The default diagnostics base path is `/diagnostics/v1`; requests use `credentials: "same-origin"`. Stream retries use a configurable delay (default one second), stop on permanent HTTP errors or a server `disconnect` event, and support explicit cancellation. Never persist an operator token in browser storage. Server authorization, Origin/network policy, redaction, duration, buffer, and rate limits remain authoritative.

## ESM

```html
<script type="module">
  import { RealtimeClient } from "./cormier-realtime.min.js";

  const client = new RealtimeClient({
    url: "/realtime/ws",
    authentication: { kind: "session" },
  });
  await client.connect();
  await client.subscribe("topics/orders", ({ payload }) => {
    console.log("Order event received", payload);
  });
</script>
```

## Direct browser script

```html
<script src="./cormier-realtime.iife.min.js"></script>
<script>
  const client = new CormierRealtime.RealtimeClient({
    url: "/realtime/ws",
    authentication: { kind: "ticket" },
  });
  client.connect();
</script>
```

Ticket mode POSTs to `/realtime/tickets` resolved against the WebSocket origin before every connection attempt, using Fetch `credentials: "include"`. Override `authentication.endpoint` or inject `authentication.fetch` when needed. Prefer same-origin hosting; any cross-origin deployment must deliberately configure browser cookie/CORS and gateway Origin policy. The ticket is placed in the WebSocket handshake URL and is not returned as a ticket field in library event/error callbacks. Do not log WebSocket URLs at the edge or in a custom transport because ticket query parameters are credential material. Do not supply the reserved `reconnect` query parameter yourself.

## Behavior

- `connect`, `publish`, `subscribe`, `unsubscribe`, `ping`, and `disconnect` use the `cormier.realtime.v1` subprotocol.
- Command and pending-acknowledgement collections are bounded. Saturation rejects new work with `RealtimeQueueError` rather than growing memory without limit.
- A browser heartbeat prevents the gateway's idle timeout from treating a healthy connection as stale.
- Unexpected disconnects use bounded exponential backoff with jitter and a maximum attempt count. A reconnect obtains a fresh ticket when ticket mode is selected.
- Desired subscriptions are restored once on a new connection. Multiple local listeners for one route share one server subscription.
- `subscribe` resolves to an async disposer for that local listener. Use `on("state", ...)`, `on("close", ...)`, `on("event", ...)`, and `on("error", ...)` for lifecycle reporting; `on` returns a listener-removal function. Catch the initial `connect()` rejection explicitly; an initial failed connection is not automatically retried like an established connection that drops.
- Server errors become `RealtimeError` instances with stable codes. Unknown optional server fields are ignored.
- Pub/Sub events are ephemeral. A reconnect cannot replay messages missed while disconnected. Durable delivery is a separately approved Redis Streams behavior and is not implied by this client.

Load balancers and WAFs need only ordinary WebSocket upgrade forwarding, an idle timeout longer than the configured heartbeat interval, and query-string redaction. Sticky sessions and application-specific edge integration are not required: sessions and tickets are revalidated through Redis on every new gateway connection.

## Compatibility and security

The repository browser matrix is Chromium, Firefox, and WebKit from the locked Playwright dependency. It does not establish support for every browser/version outside that matrix. The readable and minified ESM and IIFE builds expose the same public API. The baseline output target is ES2022.

The generated files contain no inline code generation, `eval`, environment address, cookie value, or ticket. A strict Content Security Policy can load the external IIFE with `script-src 'self'` or load the ESM build through an allowed module source; no `unsafe-eval` is required. Use HTTPS/WSS outside loopback development.

Validators currently require the exact envelope version `1.0`; additive optional fields are accepted, but arbitrary `1.x` version strings are not. Required envelope changes, removals, or semantic changes require the documented protocol migration. See the [protocol contract](../../docs/protocol.md); rolling upgrades must retain the prior protocol until all consumers move.

Default client limits are 128 queued commands, 128 pending acknowledgements, a ten-second command timeout and a 16 KiB serialized outgoing envelope. Heartbeats run every 15 seconds. Reconnect defaults are 500 ms initial delay, 30 seconds maximum delay, 20% jitter and 12 attempts; server restart advice can override delay/jitter. Configure these in `RealtimeClientOptions` to match gateway limits. Heartbeats cannot guarantee timely execution in suspended/background browser tabs. The client does not turn an acknowledgement into durable delivery evidence.

## Build and verification

Node.js 22 or newer is required. Run these commands from `sdk/typescript`. Browser integration tests additionally require a Release-built .NET 10 gateway and a reachable disposable Redis selected by `REDIS_TEST_ENDPOINT`; the Playwright configuration launches two gateway processes with `--no-build --no-restore` plus local proxy/static servers. Build the gateway from the repository root with `dotnet restore --locked-mode` and `dotnet build --configuration Release --no-restore` before the browser step.

```console
npm ci
npm run check
npx playwright install
npm run test:browser
```

`npm run build` emits readable and minified ESM and IIFE files, declarations, source maps, and `version.json` in `dist`. It also creates the shared reference application's readable and optimized profiles under `examples/shared-web/dist`. `npm run build:obfuscated` adds the explicit, optional obfuscated profile; obfuscation is disabled by default and is not a security boundary. `npm run build:check` verifies reproducibility of both modes and restores the default output. Source maps use source-relative names and do not contain source-machine paths.

The generated reference manifest records hashes, SRI, profile defaults, source-map policy, selector mappings, tool versions, and sizes. Production examples select optimized assets; development and support select readable assets. See [Optimized reference assets](../../docs/optimized-assets.md) for deployment, CSP, accessibility, update, debugging, and rollback guidance.

The size budget is 32 KiB per minified JavaScript artifact before compression and 12 KiB with gzip. CI rejects larger output. Troubleshooting should begin with the state, close, and structured error callbacks; these intentionally omit cookie and ticket material.
