import Foundation
import Testing

@testable import App

@Suite("Reference settings")
struct ReferenceSettingsTests {
  private var values: [String: String] {
    [
      "PORT": "15500",
      "APPLICATION_HOST": "127.0.0.1",
      "APPLICATION_PORT": "15502",
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
    #expect(settings.port == 15_500)
    #expect(settings.allows(tenant: "tenant-a", user: "user-a"))
    #expect(settings.sessionKey("id") == "cormier:test:sessions:id")
  }

  @Test("rejects unsafe origins")
  func rejectsUnsafeOrigin() {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "file:///tmp"
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
    #expect(schema.contains("PUBLIC_ORIGIN"))
    #expect(sdk.contains(#""protocolVersion": "1.0""#))
    #expect(protocolFixture.contains(#""protocolVersion": "1.0""#))
  }
}
