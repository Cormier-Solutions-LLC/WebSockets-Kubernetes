import Foundation

import NIOCore

struct ReferenceSettings: Sendable {
  let listenHost: String
  let port: Int
  let applicationHost: String
  let applicationPort: Int
  let publicOrigin: String
  let publicScheme: String
  let gatewayURL: String
  let redisURL: String
  let sessionSecret: String
  let sessionLifetime: Int
  let heartbeatIntervalMilliseconds: Int
  let instanceName: String
  let topology: String
  let redisInstancePrefix: String
  let redisSessionKeyPrefix: String
  let allowedTenants: Set<String>
  let allowedUsers: Set<String>
  let sharedAssetRoot: String
  let sdkAssetRoot: String

  init(environment: [String: String]) throws {
    self.listenHost = try Self.identifier(
      Self.required("LISTEN_HOST", in: environment), pattern: #"^[A-Za-z0-9._:-]{1,253}$"#)
    self.port = try Self.integer(Self.required("PORT", in: environment), range: 1_024...65_535)
    self.applicationHost = try Self.identifier(
      Self.required("APPLICATION_HOST", in: environment), pattern: #"^[A-Za-z0-9._:-]{1,253}$"#)
    self.applicationPort = try Self.integer(
      Self.required("APPLICATION_PORT", in: environment), range: 1_024...65_535)
    self.publicOrigin = try Self.origin(Self.required("PUBLIC_ORIGIN", in: environment))
    self.publicScheme = String(self.publicOrigin.prefix { $0 != ":" })
    self.gatewayURL = try Self.origin(Self.required("GATEWAY_URL", in: environment))
    self.redisURL = try Self.validRedisURL(Self.required("REDIS_URL", in: environment))
    self.sessionSecret = Self.required("SESSION_SECRET", in: environment)
    guard (32...4_096).contains(self.sessionSecret.utf8.count) else { throw SettingsError.invalid }
    self.sessionLifetime = try Self.integer(
      Self.required("SESSION_LIFETIME_SECONDS", in: environment), range: 60...7_200)
    self.heartbeatIntervalMilliseconds = try Self.integer(
      Self.required("HEARTBEAT_INTERVAL_MILLISECONDS", in: environment), range: 5_000...300_000)
    self.instanceName = try Self.identifier(Self.required("INSTANCE_NAME", in: environment))
    self.topology = Self.required("TOPOLOGY", in: environment)
    guard ["ha", "non-ha"].contains(self.topology) else { throw SettingsError.invalid }
    self.redisInstancePrefix = try Self.identifier(
      Self.required("REDIS_INSTANCE_PREFIX", in: environment), pattern: #"^[A-Za-z0-9._:-]{1,128}$"#
    )
    self.redisSessionKeyPrefix = try Self.identifier(
      Self.required("REDIS_SESSION_KEY_PREFIX", in: environment))
    self.allowedTenants = try Self.allowlist(Self.required("ALLOWED_TENANTS", in: environment))
    self.allowedUsers = try Self.allowlist(Self.required("ALLOWED_USERS", in: environment))
    self.sharedAssetRoot = environment["SHARED_ASSET_ROOT"] ?? "../shared-web/wwwroot"
    self.sdkAssetRoot = environment["SDK_ASSET_ROOT"] ?? "../../sdk/typescript/dist"
  }

  func allows(tenant: String, user: String) -> Bool {
    self.allowedTenants.contains(tenant) && self.allowedUsers.contains(user)
  }

  func sessionKey(_ id: String) -> String {
    "\(self.redisInstancePrefix):\(self.redisSessionKeyPrefix):\(id)"
  }

  private static func required(_ name: String, in environment: [String: String]) -> String {
    guard let value = environment[name],
      !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return "" }
    return value
  }

  private static func integer(_ value: String, range: ClosedRange<Int>) throws -> Int {
    guard let number = Int(value), range.contains(number) else { throw SettingsError.invalid }
    return number
  }

  private static func origin(_ value: String) throws -> String {
    guard value == value.lowercased(),
      let components = URLComponents(string: value),
      ["http", "https"].contains(components.scheme),
      Self.networkHost(components.host),
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path.isEmpty || components.path == "/",
      components.port.map({ (1...65_535).contains($0) }) ?? true,
      !(components.scheme == "http" && components.port == 80),
      !(components.scheme == "https" && components.port == 443)
    else { throw SettingsError.invalid }
    return value.hasSuffix("/") ? String(value.dropLast()) : value
  }

  private static func networkHost(_ host: String?) -> Bool {
    guard let host, !host.isEmpty, host.utf8.count <= 253, !host.contains("%") else {
      return false
    }
    let candidate: String
    if host.hasPrefix("[") && host.hasSuffix("]") {
      candidate = String(host.dropFirst().dropLast())
    } else {
      guard !host.contains("[") && !host.contains("]") else { return false }
      candidate = host
    }
    if candidate.contains(":") {
      guard let address = try? SocketAddress(ipAddress: candidate, port: 0), case .v6 = address
      else {
        return false
      }
      return true
    }
    if candidate.allSatisfy({ $0.isNumber || $0 == "." }) {
      guard let address = try? SocketAddress(ipAddress: candidate, port: 0), case .v4 = address
      else {
        return false
      }
      return true
    }
    return candidate.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
      label.utf8.count <= 63
        && label.range(of: #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$"#, options: .regularExpression)
          != nil
    }
  }

  private static func validRedisURL(_ value: String) throws -> String {
    guard let components = URLComponents(string: value),
      ["redis", "rediss"].contains(components.scheme),
      components.host != nil,
      components.fragment == nil
    else { throw SettingsError.invalid }
    return value
  }

  private static func identifier(_ value: String, pattern: String = #"^[A-Za-z0-9._-]{1,128}$"#)
    throws -> String
  {
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      throw SettingsError.invalid
    }
    return value
  }

  private static func allowlist(_ value: String) throws -> Set<String> {
    let items = Set(value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    guard !items.isEmpty, items.allSatisfy({ (try? Self.identifier($0)) != nil }) else {
      throw SettingsError.invalid
    }
    return items
  }
}
enum SettingsError: Error {
  case invalid
}
