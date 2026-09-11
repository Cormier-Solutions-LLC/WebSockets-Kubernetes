import Foundation
import Testing

@testable import App

@Suite("Reference settings")
struct ReferenceSettingsTests {
  @Test("accepts RFC 3339 timestamps with and without fractional seconds")
  func acceptsRFC3339TimestampForms() {
    #expect(parseTimestamp("2026-09-11T12:34:56Z") != nil)
    #expect(parseTimestamp("2026-09-11T12:34:56.123Z") != nil)
    #expect(parseTimestamp("not-a-timestamp") == nil)
  }

  private var values: [String: String] {
    [
      "LISTEN_HOST": "127.0.0.1",
      "PORT": "15500",
      "APPLICATION_HOST": "127.0.0.1",
      "APPLICATION_PORT": "15502",
      "APP_URL": "http://127.0.0.1:15502",
      "PUBLIC_ORIGIN": "http://127.0.0.1:15500",
      "GATEWAY_URL": "http://127.0.0.1:15501",
      "REDIS_URL": "redis://127.0.0.1:6379",
      "SESSION_SECRET": String(repeating: "x", count: 32),
      "SESSION_LIFETIME_SECONDS": "1200",
      "INSTANCE_NAME": "swift-vapor-a",
      "TOPOLOGY": "non-ha",
      "REDIS_INSTANCE_PREFIX": "cormier:test",
      "REDIS_SESSION_KEY_PREFIX": "sessions",
      "ALLOWED_TENANTS": "tenant-a",
      "ALLOWED_USERS": "user-a",
    ]
  }

  @Test("loads typed settings")
  func loadsTypedSettings() throws {
    let settings = try ReferenceSettings(environment: self.values)
    #expect(settings.listenHost == "127.0.0.1")
    #expect(settings.port == 15_500)
    #expect(settings.publicScheme == "http")
    #expect(settings.allows(tenant: "tenant-a", user: "user-a"))
    #expect(settings.sessionKey("id") == "cormier:test:sessions:id")
  }

  @Test("derives the public relay scheme")
  func derivesPublicRelayScheme() throws {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "https://example.test"
    let settings = try ReferenceSettings(environment: environment)
    #expect(settings.publicScheme == "https")

    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let caddyfile = try String(contentsOf: root.appending(path: "Caddyfile"), encoding: .utf8)
    #expect(caddyfile.contains("header_up X-Forwarded-Proto {$PUBLIC_SCHEME}"))
  }

  @Test("rejects unsafe origins")
  func rejectsUnsafeOrigin() {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "file:///tmp"
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
  }

  @Test("rejects explicit default origin ports")
  func rejectsExplicitDefaultOriginPort() {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "https://example.test:443"
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
  }

  @Test("rejects noncanonical origin casing")
  func rejectsNoncanonicalOriginCasing() {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "https://EXAMPLE.TEST"
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
  }

  @Test("aligns private listener hosts with the shared contract")
  func alignsPrivateListenerHosts() throws {
    var environment = self.values
    environment["APPLICATION_HOST"] = "::1"
    #expect(try ReferenceSettings(environment: environment).applicationHost == "::1")
    environment["APPLICATION_HOST"] = String(repeating: "a", count: 254)
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
  }

  @Test("uses canonical contracts")
  func usesCanonicalContracts() throws {
    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
      .deletingLastPathComponent().deletingLastPathComponent()
    let schema = try String(
      contentsOf: root.appending(path: "examples/shared-web/reference-app.schema.json"),
      encoding: .utf8)
    let sdk = try String(
      contentsOf: root.appending(path: "sdk/typescript/dist/version.json"), encoding: .utf8)
    let protocolFixture = try String(
      contentsOf: root.appending(path: "protocol/fixtures/v1/envelopes.json"), encoding: .utf8)
    for name in ["APPLICATION_HOST", "APPLICATION_PORT", "APP_URL"] {
      #expect(schema.contains("\"\(name)\""))
    }
    #expect(sdk.contains(#""protocolVersion": "1.0""#))
    #expect(protocolFixture.contains(#""protocolVersion": "1.0""#))
  }

  @Test("preflight checks the SDK bundle loaded by the shared page")
  func preflightChecksLoadedSDKBundle() throws {
    let source = try String(contentsOfFile: "Sources/App/configure.swift", encoding: .utf8)
    #expect(source.contains("cormier-realtime.iife.js"))
    #expect(!source.contains("cormier-realtime.iife.min.js"))
  }
}
