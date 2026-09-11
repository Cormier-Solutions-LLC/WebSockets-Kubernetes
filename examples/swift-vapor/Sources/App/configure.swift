import Foundation
@preconcurrency import Redis
import Vapor

func configure(_ application: Application) throws {
  let settings = try ReferenceSettings(environment: ProcessInfo.processInfo.environment)
  try validateAssets(settings)

  application.http.server.configuration.hostname = settings.applicationHost
  application.http.server.configuration.port = settings.applicationPort
  application.routes.defaultMaxBodySize = "64kb"
  application.redis.configuration = try RedisConfiguration(
    url: settings.redisURL,
    pool: .init(connectionRetryTimeout: .seconds(5))
  )
  application.lifecycle.use(RedisStartupCheck())

  application.middleware.use(SecurityHeadersMiddleware())
  routes(application, settings: settings)
}

private struct RedisStartupCheck: LifecycleHandler {
  func didBootAsync(_ application: Application) async throws {
    _ = try await application.redis.send(command: "PING", with: [])
  }
}

private func validateAssets(_ settings: ReferenceSettings) throws {
  let required = [
    "\(settings.sharedAssetRoot)/index.html",
    "\(settings.sharedAssetRoot)/app.css",
    "\(settings.sharedAssetRoot)/app.js",
    "\(settings.sdkAssetRoot)/cormier-realtime.iife.min.js",
  ]
  guard required.allSatisfy(FileManager.default.fileExists(atPath:)) else {
    throw SettingsError.invalid
  }
}

struct SecurityHeadersMiddleware: AsyncMiddleware {
  func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
    let response = try await next.respond(to: request)
    response.headers.replaceOrAdd(name: .cacheControl, value: "no-store")
    response.headers.replaceOrAdd(
      name: "Content-Security-Policy",
      value:
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'"
    )
    response.headers.replaceOrAdd(name: "Referrer-Policy", value: "no-referrer")
    response.headers.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
    response.headers.replaceOrAdd(name: "X-Frame-Options", value: "DENY")
    return response
  }
}
