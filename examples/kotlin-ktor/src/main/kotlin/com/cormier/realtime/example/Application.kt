package com.cormier.realtime.example

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets as ClientWebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.http.ContentType
import io.ktor.http.Cookie
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.header
import io.ktor.server.request.receiveChannel
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondFile
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.pingPeriod
import io.ktor.server.websocket.timeout
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import io.ktor.websocket.send
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.io.ByteArrayOutputStream
import java.nio.file.Path
import java.security.SecureRandom
import java.time.Instant
import java.util.HexFormat
import kotlin.time.Duration.Companion.seconds
import kotlin.system.exitProcess

private const val SESSION_COOKIE = "cormier_session"
private const val SUBPROTOCOL = "cormier.realtime.v1"
private const val MAXIMUM_BODY_BYTES = 64 * 1024
private const val FORWARDED_PROTO = "X-Forwarded-Proto"

fun main() {
    try {
        val config = ReferenceConfig.load()
        val store = LettuceSessionStore.connect(config.redisUrl)
        val client = HttpClient(CIO) { install(ClientWebSockets) }
        val server = embeddedServer(Netty, host = config.listenHost, port = config.port) { referenceModule(config, store, client) }
        Runtime.getRuntime().addShutdownHook(Thread {
            server.stop(1_000, 15_000)
            client.close()
            store.close()
        })
        server.start(wait = true)
    } catch (error: Throwable) {
        LoggerFactory.getLogger("com.cormier.realtime.example.Startup")
            .error("event=startup_failed error={}", error.javaClass.simpleName)
        exitProcess(1)
    }
}

fun Application.referenceModule(config: ReferenceConfig, store: SessionStore, client: HttpClient) {
    val json = Json { ignoreUnknownKeys = false }
    install(ContentNegotiation) { json(json) }
    install(WebSockets) {
        pingPeriod = 20.seconds
        timeout = 10.seconds
        maxFrameSize = 64 * 1024
    }
    install(StatusPages) {
        exception<ClientFault> { call, fault ->
            call.respond(fault.status, ErrorResponse(fault.code, fault.message ?: "The request is invalid."))
        }
        exception<Throwable> { call, error ->
            this@referenceModule.log.error("event=request_failed error={}", error.javaClass.simpleName)
            call.respond(HttpStatusCode.ServiceUnavailable,
                ErrorResponse("service_unavailable", "The reference application dependency is unavailable."))
        }
    }
    intercept(ApplicationCallPipeline.Plugins) {
        call.response.headers.append("X-Content-Type-Options", "nosniff")
        call.response.headers.append("X-Frame-Options", "DENY")
        call.response.headers.append("Referrer-Policy", "no-referrer")
        call.response.headers.append("Content-Security-Policy",
            "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'")
        if (call.request.path().startsWith("/api/") || call.request.path().startsWith("/realtime/") ||
            call.request.path() == "/health") call.response.headers.append(HttpHeaders.CacheControl, "no-store")
    }

    routing {
        get("/") { call.respondFile(config.sharedAssetRoot.resolve("index.html").toFile()) }
        get("/app.css") { call.respondFile(config.sharedAssetRoot.resolve("app.css").toFile()) }
        get("/app.js") { call.respondFile(config.sharedAssetRoot.resolve("app.js").toFile()) }
        get("/_content/Cormier.Realtime.Browser/{asset}") {
            val asset = safeAsset(config.sdkAssetRoot, call.parameters["asset"])
            call.respondFile(asset.toFile())
        }
        get("/health") {
            val ready = runCatching { store.ready() }.getOrDefault(false)
            call.respond(if (ready) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable,
                mapOf("status" to if (ready) "healthy" else "unavailable"))
        }
        get("/api/diagnostics") {
            call.respond(mapOf(
                "stack" to "Kotlin / Ktor", "topology" to config.topology, "instance" to config.instanceName,
                "redis" to if (runCatching { store.ready() }.getOrDefault(false)) "ready" else "unavailable",
                "timestamp" to Instant.now().toString(),
            ))
        }
        post("/api/login") {
            requireOrigin(call.request.header(HttpHeaders.Origin), config)
            val request = json.decodeFromString<LoginRequest>(readLimitedBody(call.receiveChannel()).decodeToString())
            if (!config.allows(request.tenantId, request.userId)) throw ClientFault(
                HttpStatusCode.BadRequest, "invalid_identity", "Select a configured test tenant and user.")
            val bytes = ByteArray(24).also(SecureRandom()::nextBytes)
            val sessionId = HexFormat.of().formatHex(bytes)
            val record = SessionRecord(request.tenantId!!, request.userId!!, listOf("orders", "notifications"),
                Instant.now().plusSeconds(config.sessionLifetimeSeconds).toString(), false)
            check(store.put(config.sessionKey(sessionId), json.encodeToString(record), config.sessionLifetimeSeconds))
            call.response.cookies.append(Cookie(SESSION_COOKIE, sessionId, maxAge = config.sessionLifetimeSeconds.toInt(),
                path = "/", secure = config.publicOrigin.scheme == "https", httpOnly = true,
                extensions = mapOf("SameSite" to "Strict")))
            call.respond(LoginResponse(record.tenantId, record.userId, record.expiresAt))
        }
        get("/api/session") {
            val sessionId = call.request.cookies[SESSION_COOKIE]
            if (sessionId == null || !sessionId.matches(Regex("[A-Za-z0-9_-]{16,256}"))) unauthorized()
            val value = store.get(config.sessionKey(sessionId)) ?: unauthorized()
            val record = json.decodeFromString<SessionRecord>(value)
            if (record.revoked || Instant.parse(record.expiresAt) <= Instant.now()) unauthorized()
            call.respond(SessionResponse(true, record.tenantId, record.userId, record.allowedTopics, record.expiresAt))
        }
        post("/api/logout") {
            requireOrigin(call.request.header(HttpHeaders.Origin), config)
            call.request.cookies[SESSION_COOKIE]?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{16,256}")) }
                ?.let { store.remove(config.sessionKey(it)) }
            call.response.cookies.append(Cookie(SESSION_COOKIE, "", maxAge = 0, path = "/",
                secure = config.publicOrigin.scheme == "https", httpOnly = true,
                extensions = mapOf("SameSite" to "Strict")))
            call.respond(HttpStatusCode.NoContent)
        }
        post("/realtime/tickets") {
            requireOrigin(call.request.header(HttpHeaders.Origin), config)
            val body = readLimitedBody(call.receiveChannel())
            val response = client.post(config.gatewayUrl.resolve("/realtime/tickets").toString()) {
                header(HttpHeaders.Origin, config.publicOrigin.toString())
                header(FORWARDED_PROTO, config.publicOrigin.scheme)
                call.request.header(HttpHeaders.Cookie)?.let { header(HttpHeaders.Cookie, it) }
                call.request.header(HttpHeaders.Host)?.let { header(HttpHeaders.Host, it) }
                call.request.header(HttpHeaders.ContentType)?.let { header(HttpHeaders.ContentType, it) }
                setBody(body)
            }
            call.respondBytes(response.body<ByteArray>(), ContentType.Application.Json, response.status)
        }
        webSocket("/realtime/ws", protocol = SUBPROTOCOL) browser@{
            val browserOrigin = call.request.header(HttpHeaders.Origin)
            requireOrigin(browserOrigin, config)
            val query = call.request.queryParameters.entries()
                .flatMap { (name, values) -> values.map { value -> name to value } }
            val upstreamUrl = config.gatewayUrl.resolve("/realtime/ws").toString().replaceFirst("http", "ws")
            client.webSocket(request = {
                url(upstreamUrl)
                url {
                    query.forEach { (name, value) -> parameters.append(name, value) }
                }
                header(HttpHeaders.Origin, browserOrigin!!)
                header(FORWARDED_PROTO, config.publicOrigin.scheme)
                call.request.header(HttpHeaders.Cookie)?.let { header(HttpHeaders.Cookie, it) }
                call.request.header(HttpHeaders.Host)?.let { header(HttpHeaders.Host, it) }
                header(HttpHeaders.SecWebSocketProtocol, SUBPROTOCOL)
            }) gateway@{
                coroutineScope {
                    val toGateway = launch {
                        for (frame in this@browser.incoming) when (frame) {
                            is Frame.Text -> this@gateway.send(Frame.Text(frame.readText()))
                            is Frame.Binary -> this@gateway.send(Frame.Binary(true, frame.readBytes()))
                            is Frame.Close -> {
                                this@gateway.send(frame)
                                return@launch
                            }
                            else -> Unit
                        }
                    }
                    val toBrowser = launch {
                        for (frame in incoming) when (frame) {
                            is Frame.Text -> this@browser.send(Frame.Text(frame.readText()))
                            is Frame.Binary -> this@browser.send(Frame.Binary(true, frame.readBytes()))
                            is Frame.Close -> {
                                this@browser.send(frame)
                                return@launch
                            }
                            else -> Unit
                        }
                    }
                    select {
                        toGateway.onJoin { toBrowser.cancelAndJoin() }
                        toBrowser.onJoin { toGateway.cancelAndJoin() }
                    }
                }
            }
        }
    }
}

private suspend fun readLimitedBody(channel: io.ktor.utils.io.ByteReadChannel): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
        val count = channel.readAvailable(buffer, 0, buffer.size)
        if (count == -1) break
        if (output.size() + count > MAXIMUM_BODY_BYTES) throw ClientFault(
            HttpStatusCode.PayloadTooLarge, "invalid_request", "The request is invalid.")
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

private fun requireOrigin(origin: String?, config: ReferenceConfig) {
    if (origin != config.publicOrigin.toString()) throw ClientFault(
        HttpStatusCode.Forbidden, "origin_rejected", "The request Origin is not allowed.")
}

private fun unauthorized(): Nothing = throw ClientFault(
    HttpStatusCode.Unauthorized, "authentication_required", "Authentication is required.")

private fun safeAsset(root: Path, name: String?): Path {
    if (name == null || !name.matches(Regex("[A-Za-z0-9._-]+"))) throw ClientFault(HttpStatusCode.NotFound, "not_found", "Not found.")
    val normalizedRoot = root.toAbsolutePath().normalize()
    return normalizedRoot.resolve(name).normalize().takeIf { it.startsWith(normalizedRoot) }
        ?: throw ClientFault(HttpStatusCode.NotFound, "not_found", "Not found.")
}

private class ClientFault(val status: HttpStatusCode, val code: String, message: String) : RuntimeException(message)
@Serializable private data class LoginRequest(val tenantId: String? = null, val userId: String? = null)
@Serializable private data class SessionRecord(val tenantId: String, val userId: String, val allowedTopics: List<String>, val expiresAt: String, val revoked: Boolean)
@Serializable private data class LoginResponse(val tenantId: String, val userId: String, val expiresAt: String)
@Serializable private data class SessionResponse(val authenticated: Boolean, val tenantId: String, val userId: String, val allowedTopics: List<String>, val expiresAt: String)
@Serializable private data class ErrorResponse(val code: String, val message: String)
