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
    _ = try await boundedRedis(application.redis.send(command: "PING", with: []))
  }
}

enum RedisDeadlineError: Error {
  case exceeded
}

private final class RedisDeadlineGate<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false

  func complete(
    _ result: Result<Value, any Error>, promise: EventLoopPromise<Value>
  ) {
    self.lock.lock()
    guard !self.completed else {
      self.lock.unlock()
      return
    }
    self.completed = true
    self.lock.unlock()
    promise.completeWith(result)
  }
}

func boundedRedis<Value: Sendable>(
  _ future: EventLoopFuture<Value>, deadline: TimeAmount = .seconds(5)
) async throws -> Value {
  let promise = future.eventLoop.makePromise(of: Value.self)
  let gate = RedisDeadlineGate<Value>()
  let timeout = future.eventLoop.scheduleTask(in: deadline) {
    gate.complete(.failure(RedisDeadlineError.exceeded), promise: promise)
  }
  future.whenComplete { result in
    gate.complete(result, promise: promise)
    timeout.cancel()
  }
  return try await promise.futureResult.get()
}

private func validateAssets(_ settings: ReferenceSettings) throws {
  let required = [
    "\(settings.sharedAssetRoot)/index.html",
    "\(settings.sharedAssetRoot)/app.css",
    "\(settings.sharedAssetRoot)/app.js",
    "\(settings.sdkAssetRoot)/cormier-realtime.iife.js",
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
