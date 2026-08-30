# Realtime wire protocol

## Connection and authentication

Connect to `/realtime/ws` with the `propago.realtime.v1` WebSocket subprotocol. Browser clients authenticate with the `propago_session` HttpOnly cookie. Cookie authentication is accepted only when `Origin` exactly matches the request scheme, host, and effective port and is present in `Realtime:AllowedOrigins`. Tenant ID, user ID, topic grants, revocation, and expiry come only from the namespaced Redis session record; none are accepted from client payloads.

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

The default frame limit is 16 KiB and message limit is 64 KiB. Fragmentation is deliberately rejected, so the effective assembled-message limit is also the frame limit. Binary messages close with `1003`; fragmented or invalid payloads close with `1007`; oversized messages close with `1009`. Clients must send `ping` traffic inside the 45-second idle window. The server emits a heartbeat every 15 seconds and closes idle clients with private code `4009`.

Each connection has a bounded 128-message outbound queue. A full queue drops the new event and increments the queue-drop metric; three consecutive saturation strikes close the slow consumer with `4008`. When the authenticated session or ticket identity expires, the gateway rejects further commands and closes with `4003`; the client must reauthenticate. A pod drain emits `service.restart`, including initial delay 500 ms, maximum delay 30 seconds, jitter ratio 0.2, and reauthentication required, then closes with `1012`.

Clients should use exponential reconnect delay capped by the advertised maximum and apply random jitter in the range represented by `jitterRatio`. Reconnects must create a new authenticated connection, resubscribe desired routes, and must not assume they land on the same gateway instance.

## Delivery semantics

Redis Pub/Sub provides ephemeral cross-instance fan-out. Messages published while no subscribed gateway is connected are not replayed. The channel and all keys are namespaced by `Redis:InstancePrefix`; live WebSocket objects and local subscriptions are never stored in Redis.

Redis Streams are optional and apply only when `eventClass` exactly matches `Realtime:DurableEventClasses`. Streams provide bounded retention, consumer-group acknowledgment, idle pending-entry reassignment, at-least-once delivery, Redis-backed message idempotency markers, and a bounded poison stream for invalid JSON. Consumers must mark a message ID once, perform idempotent side effects, and acknowledge the stream entry. Pub/Sub delivery and Streams replay are separate semantics and must not be treated as interchangeable.

## Compatibility policy

Version `1.0` is matched exactly. Additive optional payload fields may be introduced within 1.x, but required envelope changes, type semantic changes, and field removals require a new protocol version and subprotocol. Unsupported versions and message types receive structured errors. Clients must ignore unknown optional server fields.

Metrics and traces include operation, outcome, correlation, close code, and aggregate counters. They must never include cookies, tickets, payloads, tenant IDs, or user IDs. Structured logs follow the same restriction.
