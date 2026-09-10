# Cormier.Realtime.Redis

Redis-backed Pub/Sub, durable Streams, session validation, and connection-ticket infrastructure for Cormier.Realtime hosts.

Install this package directly only when composing the lower-level Redis services. Most ASP.NET Core applications should install `Cormier.Realtime.AspNetCore`, which carries the compatible Redis and Contracts dependencies.

Redis endpoints, credentials, key prefixes, and deployment identities are configuration and are never embedded in this package.
