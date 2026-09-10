# Cormier.Realtime TypeScript and browser SDK

`@cormier/realtime` is the typed browser client for wire protocol `1.0`. It supports same-origin HttpOnly session cookies and short-lived, single-use connection tickets without exposing authentication material through callbacks, errors, or library logging.

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

Ticket mode POSTs to `/realtime/tickets` with same-origin credentials before every connection attempt. The ticket is placed only in the WebSocket handshake URL and is never returned to an event or error callback. Do not log WebSocket URLs at the edge because ticket query parameters are credential material.

## Behavior

- `connect`, `publish`, `subscribe`, `unsubscribe`, `ping`, and `disconnect` use the `cormier.realtime.v1` subprotocol.
- Command and pending-acknowledgement collections are bounded. Saturation rejects new work with `RealtimeQueueError` rather than growing memory without limit.
- A browser heartbeat prevents the gateway's idle timeout from treating a healthy connection as stale.
- Unexpected disconnects use bounded exponential backoff with jitter and a maximum attempt count. A reconnect obtains a fresh ticket when ticket mode is selected.
- Desired subscriptions are restored once on a new connection. Multiple local listeners for one route share one server subscription.
- Server errors become `RealtimeError` instances with stable codes. Unknown optional server fields are ignored.
- Pub/Sub events are ephemeral. A reconnect cannot replay messages missed while disconnected. Durable delivery is a separately approved Redis Streams behavior and is not implied by this client.

Load balancers and WAFs need only ordinary WebSocket upgrade forwarding, an idle timeout longer than the configured heartbeat interval, and query-string redaction. Sticky sessions and application-specific edge integration are not required: sessions and tickets are revalidated through Redis on every new gateway connection.

## Compatibility and security

The supported browser matrix is the current Playwright Chromium, Firefox, and WebKit release channels, corresponding to maintained evergreen Chrome/Edge, Firefox, and Safari generations. The readable and minified ESM and IIFE builds have identical public exports. The baseline output target is ES2022.

The generated files contain no inline code generation, `eval`, environment address, cookie value, or ticket. A strict Content Security Policy can load the external IIFE with `script-src 'self'` or load the ESM build through an allowed module source; no `unsafe-eval` is required. Use HTTPS/WSS outside loopback development.

Protocol `1.x` may add optional response fields. Consumers must ignore them. Required envelope changes, removals, or semantic changes require a new protocol/subprotocol and a new SDK major version. Upgrade the gateway and SDK within the compatibility table in `docs/protocol.md`; rolling upgrades must retain the prior protocol until all consumers move.

## Build and verification

Node.js 22 or newer is required.

```console
npm ci
npm run check
npx playwright install
npm run test:browser
```

`npm run build` emits readable and minified ESM and IIFE files, declarations, source maps, and `version.json` in `dist`. `npm run build:check` creates the output twice and compares SHA-256 inventories. Source maps use repository-relative source names and do not contain source-machine paths.

The size budget is 32 KiB per minified JavaScript artifact before compression and 12 KiB with gzip. CI rejects larger output. Troubleshooting should begin with the state, close, and structured error callbacks; these intentionally omit cookie and ticket material.
