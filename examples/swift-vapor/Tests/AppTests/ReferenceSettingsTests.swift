import Foundation

import Logging

@preconcurrency import NIOPosix

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
      "HEARTBEAT_INTERVAL_MILLISECONDS": "5000",
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
    #expect(settings.heartbeatIntervalMilliseconds == 5_000)
  }

  @Test("rejects invalid heartbeat intervals", arguments: ["", "4999", "300001", "not-an-integer"])
  func rejectsInvalidHeartbeatIntervals(_ heartbeat: String) {
    var environment = self.values
    environment["HEARTBEAT_INTERVAL_MILLISECONDS"] = heartbeat
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
  }

  @Test("requires the heartbeat interval")
  func requiresHeartbeatInterval() {
    var environment = self.values
    environment.removeValue(forKey: "HEARTBEAT_INTERVAL_MILLISECONDS")
    #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
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

  @Test("validates complete origin host syntax")
  func validatesCompleteOriginHosts() throws {
    for host in [
      "a..b", "-bad.example", "bad-.example", "999.999.999.999", "127.1",
      "\(String(repeating: "a", count: 64)).example", "[fe80::1%25eth0]",
    ] {
      var environment = self.values
      environment["GATEWAY_URL"] = "https://\(host)"
      #expect(throws: SettingsError.self) { try ReferenceSettings(environment: environment) }
    }
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "https://[::1]"
    environment["GATEWAY_URL"] = "http://192.0.2.1:15401"
    _ = try ReferenceSettings(environment: environment)
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

  @Test("rejects out-of-range origin ports")
  func rejectsOutOfRangeOriginPort() {
    var environment = self.values
    environment["PUBLIC_ORIGIN"] = "https://example.test:99999"
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
    #expect(source.contains("cormier-realtime.iife.min.js"))
  }

  @Test("caps ticket responses while the HTTP client streams them")
  func capsTicketResponsesWhileStreaming() throws {
    let source = try String(contentsOfFile: "Sources/App/routes.swift", encoding: .utf8)
    #expect(source.contains("ResponseAccumulator("))
    #expect(source.contains("maxBodySize: maximumBodyBytes"))
    #expect(source.contains("delegate: accumulator"))
    #expect(source.contains("let deadline: NIODeadline = .now() + .seconds(15)"))
    #expect(source.contains("delegate: accumulator, deadline: deadline"))
  }

  @Test("closes Redis connections when command deadlines expire")
  func closesTimedOutRedisConnections() throws {
    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let source = try String(
      contentsOf: root.appending(path: "Sources/App/configure.swift"), encoding: .utf8)
    #expect(source.contains("self.channels.closeAll()"))
    #expect(source.contains("connectionRetryTimeout: .seconds(5)"))
    #expect(source.contains("connectTimeout(.seconds(5))"))
  }

  @Test("fails a stalled Redis command and releases its channel")
  func failsStalledRedisCommand() async throws {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    let server = try await ServerBootstrap(group: group)
      .childChannelInitializer { channel in channel.eventLoop.makeSucceededVoidFuture() }
      .bind(host: "127.0.0.1", port: 0).get()
    let port = try #require(server.localAddress?.port)
    let pool = try DeadlineRedisPool(
      url: "redis://127.0.0.1:\(port)", eventLoop: group.next(),
      logger: Logger(label: "redis-deadline-test"))
    let clock = ContinuousClock()
    let started = clock.now

    await #expect(throws: (any Error).self) {
      try await pool.send(command: "PING", with: [], deadline: .milliseconds(25))
    }
    #expect(started.duration(to: clock.now) < .seconds(1))

    pool.close()
    try await server.close().get()
    try await group.shutdownGracefully()
  }

  @Test("launcher waits for the stack-specific public endpoint")
  func launcherWaitsForPublicEndpoint() throws {
    let source = try String(contentsOfFile: "start.sh", encoding: .utf8)
    #expect(source.contains("/api/diagnostics"))
    #expect(source.contains(#"--header "Host: $public_authority""#))
    #expect(source.contains(#"grep -F '"stack":"Swift'"#))
    #expect(
      source.firstRange(of: "readiness_url=")!.lowerBound
        < source.firstRange(of: "application_started")!.lowerBound)
  }

  @Test("direct lifecycle reports startup only after boot")
  func directLifecycleReportsStartupAfterBoot() throws {
    let entryPoint = try String(contentsOfFile: "Sources/App/EntryPoint.swift", encoding: .utf8)
    let configuration = try String(contentsOfFile: "Sources/App/configure.swift", encoding: .utf8)
    #expect(!entryPoint.contains("application_started"))
    #expect(configuration.contains("func didBootAsync"))
    #expect(configuration.contains("application_started"))
  }
}
