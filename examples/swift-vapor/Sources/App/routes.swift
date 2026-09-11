import AsyncHTTPClient
import Foundation
import NIOCore
@preconcurrency import Redis
import Vapor

private let sessionCookie = "cormier_session"
private let maximumBodyBytes = 64 * 1_024

struct LoginInput: Content {
  let tenantId: String
  let userId: String
}

struct SessionRecord: Content {
  let tenantId: String
  let userId: String
  let allowedTopics: [String]
  let expiresAt: String
  let revoked: Bool
}

struct SessionResponse: Content {
  let authenticated: Bool
  let tenantId: String
  let userId: String
  let allowedTopics: [String]
  let expiresAt: String
}

struct Diagnostics: Content {
  let stack: String
  let topology: String
  let instance: String
  let redis: String
  let timestamp: String
}

struct StatusBody: Content { let status: String }
struct ErrorBody: Content {
  let code: String
  let message: String
}

func routes(_ application: Application, settings: ReferenceSettings) {
  application.get { request in
    try asset(request, path: "\(settings.sharedAssetRoot)/index.html", type: .html)
  }
  application.get("app.css") { request in
    try asset(request, path: "\(settings.sharedAssetRoot)/app.css", type: .css)
  }
  application.get("app.js") { request in
    try asset(
      request, path: "\(settings.sharedAssetRoot)/app.js",
      type: HTTPMediaType(type: "text", subType: "javascript", parameters: ["charset": "utf-8"]))
  }
  application.get("_content", "Cormier.Realtime.Browser", "**") { request -> Response in
    let name = request.parameters.getCatchall().joined(separator: "/")
    guard name.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
      throw Abort(.notFound)
    }
    let type =
      name.hasSuffix(".js")
      ? HTTPMediaType(type: "text", subType: "javascript", parameters: ["charset": "utf-8"]) : .json
    return try asset(request, path: "\(settings.sdkAssetRoot)/\(name)", type: type)
  }

  application.get("health") { request async -> Response in
    do {
      _ = try await request.application.deadlineRedis.send(command: "PING", with: [])
      return try await StatusBody(status: "healthy").encodeResponse(for: request)
    } catch {
      return try! await StatusBody(status: "unavailable").encodeResponse(
        status: .serviceUnavailable, for: request)
    }
  }

  application.get("api", "diagnostics") { request async -> Diagnostics in
    let redisStatus: String
    do {
      _ = try await request.application.deadlineRedis.send(command: "PING", with: [])
      redisStatus = "ready"
    } catch {
      redisStatus = "unavailable"
    }
    return Diagnostics(
      stack: "Swift / Vapor", topology: settings.topology, instance: settings.instanceName,
      redis: redisStatus, timestamp: timestamp())
  }

  application.post("api", "login") { request async -> Response in
    guard validOrigin(request, settings: settings) else {
      return try! await errorResponse(
        .forbidden, "origin_rejected", "The request Origin is not allowed.", request)
    }
    do {
      let input = try request.content.decode(LoginInput.self)
      guard settings.allows(tenant: input.tenantId, user: input.userId) else {
        return try await errorResponse(
          .badRequest, "invalid_identity", "Select a configured test tenant and user.", request)
      }
      let id = randomID()
      let expiry = Date(timeIntervalSinceNow: TimeInterval(settings.sessionLifetime))
      let record = SessionRecord(
        tenantId: input.tenantId, userId: input.userId, allowedTopics: ["orders", "notifications"],
        expiresAt: timestamp(expiry), revoked: false)
      let encoded = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
      _ = try await request.application.deadlineRedis.send(
        command: "SETEX",
        with: [
          .init(from: settings.sessionKey(id)), .init(from: settings.sessionLifetime),
          .init(from: encoded),
        ])
      let response = try await record.encodeResponse(for: request)
      response.cookies[sessionCookie] = .init(
        string: id,
        expires: expiry,
        maxAge: settings.sessionLifetime,
        domain: nil,
        path: "/",
        isSecure: settings.publicOrigin.hasPrefix("https://"),
        isHTTPOnly: true,
        sameSite: .strict
      )
      return response
    } catch let abort as any AbortError {
      return try! await errorResponse(
        abort.status, "invalid_request", "The request is invalid.", request)
    } catch {
      return await dependencyUnavailable(request, caught: error)
    }
  }

  application.get("api", "session") { request async -> Response in
    do {
      guard let record = try await readSession(request, settings: settings) else {
        return try await errorResponse(
          .unauthorized, "authentication_required", "Authentication is required.", request)
      }
      return try await SessionResponse(
        authenticated: true, tenantId: record.tenantId, userId: record.userId,
        allowedTopics: record.allowedTopics, expiresAt: record.expiresAt
      ).encodeResponse(for: request)
    } catch {
      return await dependencyUnavailable(request, caught: error)
    }
  }

  application.post("api", "logout") { request async -> Response in
    guard validOrigin(request, settings: settings) else {
      return try! await errorResponse(
        .forbidden, "origin_rejected", "The request Origin is not allowed.", request)
    }
    do {
      if let id = request.cookies[sessionCookie]?.string, validSessionID(id) {
        _ = try await request.application.deadlineRedis.send(
          command: "DEL", with: [.init(from: settings.sessionKey(id))])
      }
      let response = Response(status: .noContent)
      response.cookies[sessionCookie] = .init(
        string: "", expires: .distantPast, maxAge: 0, domain: nil, path: "/",
        isSecure: settings.publicOrigin.hasPrefix("https://"), isHTTPOnly: true, sameSite: .strict)
      return response
    } catch {
      return await dependencyUnavailable(request, caught: error)
    }
  }

  application.post("realtime", "tickets") { request async -> Response in
    guard validOrigin(request, settings: settings) else {
      return try! await errorResponse(
        .forbidden, "origin_rejected", "The request Origin is not allowed.", request)
    }
    do {
      guard try await readSession(request, settings: settings) != nil else {
        return try await errorResponse(
          .unauthorized, "authentication_required", "Authentication is required.", request)
      }
      guard request.body.data?.readableBytes ?? 0 <= maximumBodyBytes else {
        return try await errorResponse(
          .payloadTooLarge, "invalid_request", "The request is invalid.", request)
      }
      var headers = HTTPHeaders()
      for name in [HTTPHeaders.Name.origin, .cookie, .contentType] {
        if let value = request.headers.first(name: name) {
          headers.replaceOrAdd(name: name, value: value)
        }
      }
      if let authority = request.headers.first(name: .host) {
        headers.replaceOrAdd(name: .host, value: authority)
      }
      headers.replaceOrAdd(name: "X-Forwarded-Proto", value: settings.publicScheme)
      let upstream = try await boundedTicketRequest(request, settings: settings, headers: headers)
      var responseHeaders = HTTPHeaders()
      responseHeaders.contentType = upstream.headers.contentType ?? .json
      let body = upstream.body.map { Response.Body(buffer: $0) } ?? .empty
      return Response(status: upstream.status, headers: responseHeaders, body: body)
    } catch {
      return await dependencyUnavailable(request, caught: error)
    }
  }
}

private func boundedTicketRequest(
  _ request: Request, settings: ReferenceSettings, headers: HTTPHeaders
) async throws -> HTTPClient.Response {
  let body = request.body.data.map { HTTPClient.Body.byteBuffer($0) }
  let outbound = try HTTPClient.Request(
    url: "\(settings.gatewayURL)/realtime/tickets", method: .POST, headers: headers, body: body)
  let accumulator = ResponseAccumulator(request: outbound, maxBodySize: maximumBodyBytes)
  let deadline: NIODeadline = .now() + .seconds(15)
  let task: HTTPClient.Task<HTTPClient.Response> =
    request.application.http.client.shared.execute(
      request: outbound, delegate: accumulator, deadline: deadline)
  return try await task.futureResult.get()
}

private func asset(_ request: Request, path: String, type: HTTPMediaType) throws -> Response {
  guard FileManager.default.fileExists(atPath: path) else { throw Abort(.notFound) }
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  var headers = HTTPHeaders()
  headers.contentType = type
  return Response(status: .ok, headers: headers, body: .init(data: data))
}

private func readSession(_ request: Request, settings: ReferenceSettings) async throws
  -> SessionRecord?
{
  guard let id = request.cookies[sessionCookie]?.string,
    validSessionID(id),
    let encoded = try await request.application.deadlineRedis.send(
      command: "GET", with: [.init(from: settings.sessionKey(id))]
    ).string,
    let data = encoded.data(using: String.Encoding.utf8),
    let record = try? JSONDecoder().decode(SessionRecord.self, from: data),
    !record.revoked,
    let expiry = parseTimestamp(record.expiresAt),
    expiry > Date()
  else { return nil }
  return record
}

private func validOrigin(_ request: Request, settings: ReferenceSettings) -> Bool {
  request.headers.first(name: .origin) == settings.publicOrigin
}

private func validSessionID(_ value: String) -> Bool {
  value.range(of: #"^[A-Za-z0-9_-]{16,256}$"#, options: .regularExpression) != nil
}

private func randomID() -> String {
  Data((0..<36).map { _ in UInt8.random(in: .min ... .max) })
    .base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func timestamp(_ date: Date = Date()) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

func parseTimestamp(_ value: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let timestamp = formatter.date(from: value) {
    return timestamp
  }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: value)
}

private func errorResponse(
  _ status: HTTPStatus, _ code: String, _ message: String, _ request: Request
) async throws -> Response {
  try await ErrorBody(code: code, message: message).encodeResponse(status: status, for: request)
}

private func dependencyUnavailable(_ request: Request, caught: any Error) async -> Response {
  request.logger.error(
    "request_failed", metadata: ["stack": "swift-vapor", "errorType": "\(type(of: caught))"])
  return try! await errorResponse(
    .serviceUnavailable, "service_unavailable",
    "The reference application dependency is unavailable.", request)
}
