# Cormier.Realtime.Contracts

Runtime-neutral, versioned wire contracts shared by the Cormier.Realtime gateway and clients. The package targets .NET Standard 2.0 and .NET 10, includes source-generated JSON metadata, and preserves camel-case compatibility with the TypeScript SDK and language-neutral fixtures.

Use `RealtimeJsonSerializerContext` for deterministic serialization and `ProtocolValidator` for strict client/server envelope validation.
