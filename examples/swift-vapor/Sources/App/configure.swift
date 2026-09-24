import Foundation

import NIOCore

import NIOPosix

@preconcurrency import NIOSSL

@preconcurrency import RediStack

@preconcurrency import Redis

import Vapor

func configure(_ application: Application) throws {
  let settings = try ReferenceSettings(environment: ProcessInfo.processInfo.environment)
  try validateAssets(settings)

  application.http.server.configuration.hostname = settings.applicationHost
  application.http.server.configuration.port = settings.applicationPort
  application.routes.defaultMaxBodySize = "64kb"
  application.deadlineRedis = try DeadlineRedisPool(
    url: settings.redisURL, eventLoop: application.eventLoopGroup.next(), logger: application.logger
  )
  application.lifecycle.use(RedisLifecycle())

  application.middleware.use(SecurityHeadersMiddleware())
  routes(application, settings: settings)
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
private final class RedisChannelSet: @unchecked Sendable {
  private let lock = NSLock()
  private var channels: [ObjectIdentifier: any Channel] = [:]

  func add(_ channel: any Channel) {
    let identifier = ObjectIdentifier(channel)
    self.lock.lock()
    self.channels[identifier] = channel
    self.lock.unlock()
    channel.closeFuture.whenComplete { [weak self] _ in
      self?.remove(identifier)
    }
  }

  func closeAll() {
    self.lock.lock()
    let active = Array(self.channels.values)
    self.lock.unlock()
    for channel in active {
      channel.close(mode: .all, promise: nil)
    }
  }

  private func remove(_ identifier: ObjectIdentifier) {
    self.lock.lock()
    self.channels.removeValue(forKey: identifier)
    self.lock.unlock()
  }
}
private struct DeadlineRedisPoolKey: StorageKey {
  typealias Value = DeadlineRedisPool
}
extension Application {
  var deadlineRedis: DeadlineRedisPool {
    get { self.storage[DeadlineRedisPoolKey.self]! }
    set { self.storage[DeadlineRedisPoolKey.self] = newValue }
  }
}
final class DeadlineRedisPool: @unchecked Sendable {
  private let channels: RedisChannelSet
  private let pool: RedisConnectionPool

  init(url: String, eventLoop: any EventLoop, logger: Logger) throws {
    let configuration = try RedisConfiguration(url: url)
    let context = try configuration.tlsConfiguration.map(NIOSSLContext.init(configuration:))
    let hostname = configuration.tlsHostname
    let channels = RedisChannelSet()
    self.channels = channels
    let tcpClient = ClientBootstrap(group: eventLoop)
      .connectTimeout(.seconds(5))
      .channelInitializer { channel in
        do {
          if let context, let hostname {
            try channel.pipeline.syncOperations.addHandler(
              NIOSSLClientHandler(context: context, serverHostname: hostname))
          }
          channels.add(channel)
          return channel.pipeline.addBaseRedisHandlers()
        } catch {
          return channel.eventLoop.makeFailedFuture(error)
        }
      }
    self.pool = RedisConnectionPool(
      configuration: .init(
        initialServerConnectionAddresses: configuration.serverAddresses,
        maximumConnectionCount: .maximumActiveConnections(2),
        connectionFactoryConfiguration: .init(
          connectionInitialDatabase: configuration.database,
          connectionPassword: configuration.password,
          connectionDefaultLogger: logger,
          tcpClient: tcpClient),
        minimumConnectionCount: 0,
        connectionRetryTimeout: .seconds(5),
        poolDefaultLogger: logger),
      boundEventLoop: eventLoop)
    self.pool.activate(logger: logger)
  }

  func send(
    command: String, with arguments: [RESPValue], deadline: TimeAmount = .seconds(5)
  ) async throws -> RESPValue {
    try await self.pool.leaseConnection { connection in
      let future = connection.send(command: command, with: arguments)
      let promise = connection.eventLoop.makePromise(of: RESPValue.self)
      let gate = RedisDeadlineGate<RESPValue>()
      let timeout = connection.eventLoop.scheduleTask(in: deadline) {
        self.channels.closeAll()
        gate.complete(.failure(RedisDeadlineError.exceeded), promise: promise)
      }
      future.whenComplete { result in
        gate.complete(result, promise: promise)
        timeout.cancel()
      }
      return promise.futureResult
    }.get()
  }

  func close() {
    self.pool.close()
  }
}
private struct RedisLifecycle: LifecycleHandler {
  func didBootAsync(_ application: Application) async throws {
    _ = try await application.deadlineRedis.send(command: "PING", with: [])
    application.logger.notice("application_started", metadata: ["stack": "swift-vapor"])
  }

  func shutdown(_ application: Application) {
    application.deadlineRedis.close()
  }
}
private func validateAssets(_ settings: ReferenceSettings) throws {
  let required = [
    "\(settings.sharedAssetRoot)/index.html",
    "\(settings.sharedAssetRoot)/app.css",
    "\(settings.sharedAssetRoot)/app.js",
    "\(settings.sdkAssetRoot)/cormier-realtime.iife.js",
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
