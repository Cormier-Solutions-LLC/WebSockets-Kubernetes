# Realtime wire protocol

## Connection and authentication

Connect to `/realtime/ws` with the `cormier.realtime.v1` WebSocket subprotocol. Browser clients authenticate with the `cormier_session` HttpOnly cookie. Cookie authentication is accepted only when `Origin` exactly matches the request scheme, host, and effective port and is present in `Realtime:AllowedOrigins`. Tenant ID, user ID, topic grants, revocation, and expiry come only from the namespaced Redis session record; none are accepted from client payloads.

Approved cross-origin and non-browser clients first POST `/realtime/tickets` using a valid same-origin session. The returned cryptographically random ticket is valid for 30 seconds by default, is bound to the request host, and is atomically consumed once via the `ticket` query parameter. A rejected audience also consumes the ticket to prevent probing or replay.

## Envelope

Every client command is one complete UTF-8 text frame:

```json
{
  "version": "1.0",
  "type": "publish",
  "correlationId": "01J6...",
  "timestamp": "2026-08-30T17:00:00Z",
  "route": "topics/orders",
  "payload": { "value": 42 }
}
```

Supported client types are `ping`, `subscribe`, `unsubscribe`, and `publish`. Routes are either `topics/{topic}` or `users/{current-user}/topics/{topic}`. Topic characters are limited to letters, digits, `.`, `_`, and `-`. Authorization is evaluated for every command against the server-derived identity. A client cannot select a tenant or another user.

`correlationId` is required, is scoped to one connection, and must not exceed 128 characters; reuse on that connection is rejected as a duplicate. `route` is required and must not exceed 256 characters. Client timestamps may be at most five minutes old or one minute in the future when received. A `publish` command requires a non-null payload.

Server frames use the same version, correlation, timestamp, route, and optional payload fields. `type` is `ack`, `event`, `error`, `ping`, or `service.restart`. Error frames add:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "The server-derived identity is not authorized for this route."
  }
}
```

Stable error codes are `invalid_envelope`, `unsupported_version`, `unsupported_type`, `duplicate_correlation`, `message_too_large`, `fragmented_message_rejected`, `unauthorized`, `queue_saturated`, `service_draining`, and `internal_error`. Error messages are diagnostic, not a compatibility surface.

## Limits, heartbeat, and close behavior

The default frame limit is 16 KiB and configured message limit is 64 KiB. Fragmentation is deliberately rejected, so the effective inbound limit is one frame and therefore 16 KiB with the defaults. Binary messages close with `1003`, fragmented text closes with `1007`, and oversized messages close with `1009`. Malformed JSON and invalid envelopes receive structured errors without closing an otherwise valid connection. Clients must send `ping` traffic inside the 45-second idle window. The server emits a heartbeat every 15 seconds and closes idle clients with private code `4009`.

Each connection has a bounded 128-message outbound queue. A full queue drops the new event and increments the queue-drop metric; three consecutive saturation strikes close the slow consumer with `4008`. When the authenticated session or ticket identity expires, the gateway rejects further commands and closes with `4003`; the client must reauthenticate. A pod drain emits `service.restart`, including initial delay 500 ms, maximum delay 30 seconds, jitter ratio 0.2, and reauthentication required, then closes with `1012`.

Clients should use exponential reconnect delay capped by the advertised maximum and apply random jitter in the range represented by `jitterRatio`. Reconnects must create a new authenticated connection, resubscribe desired routes, and must not assume they land on the same gateway instance.

## Delivery semantics

Redis Pub/Sub provides ephemeral cross-instance fan-out. Messages published while no subscribed gateway is connected are not replayed. The channel and all keys are namespaced by `Redis:InstancePrefix`; live WebSocket objects and local subscriptions are never stored in Redis.

Redis Streams are optional and apply only when `eventClass` exactly matches `Realtime:DurableEventClasses`. Streams provide bounded retention, consumer-group acknowledgment, idle pending-entry reassignment, at-least-once delivery, Redis-backed completion markers, and a bounded poison stream for invalid JSON. Consumers must perform their idempotent side effect first, record the message ID as completed only after that side effect succeeds, and then acknowledge the stream entry. A recovered entry with an existing completion marker may be acknowledged without repeating the side effect. A crash before completion leaves the entry pending for recovery; a crash after completion but before acknowledgment is safe because recovery observes the completion marker. Pub/Sub delivery and Streams replay are separate semantics and must not be treated as interchangeable.

## Compatibility policy

Version `1.0` is matched exactly. Additive optional payload fields may be introduced within 1.x, but required envelope changes, type semantic changes, and field removals require a new protocol version and subprotocol. Unsupported versions and message types receive structured errors. Clients must ignore unknown optional server fields.

Metrics use bounded operation, outcome, direction, reason, endpoint, message-type, and close-code dimensions plus aggregate counters and histograms; correlation IDs are not metric labels. Traces and structured logs may carry bounded operational context but must never include cookies, tickets, message payloads, tenant IDs, or user IDs.

Language-neutral fixtures in `protocol/fixtures/v1/envelopes.json` are consumed by both the .NET contract suite and `@cormier/realtime`. A fixture or protocol constant change that is not understood by either implementation fails CI. Later .NET consumer SDKs must consume the same fixtures; full cross-SDK live conformance is exercised by the packaged-consumer application after those SDKs are available.
