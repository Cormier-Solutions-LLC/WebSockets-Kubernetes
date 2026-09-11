package com.cormier.realtime.example

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.cookie
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReferenceApplicationTest {
    private val fixtureEnvironment = mapOf(
        "LISTEN_HOST" to "127.0.0.1", "PORT" to "15300", "PUBLIC_ORIGIN" to "http://127.0.0.1:15300",
        "GATEWAY_URL" to "http://127.0.0.1:15301", "REDIS_URL" to "redis://127.0.0.1:6379",
        "SESSION_LIFETIME_SECONDS" to "1200", "INSTANCE_NAME" to "kotlin-ktor-a", "TOPOLOGY" to "non-ha",
        "REDIS_INSTANCE_PREFIX" to "cormier:kotlin-test", "REDIS_SESSION_KEY_PREFIX" to "sessions",
        "ALLOWED_TENANTS" to "tenant-a,tenant-b", "ALLOWED_USERS" to "user-a,user-b",
        "SHARED_ASSET_ROOT" to "../shared-web/wwwroot", "SDK_ASSET_ROOT" to "../../sdk/typescript/dist",
    )

    @Test
    fun `configuration validates and consumes canonical contracts`() {
        val config = ReferenceConfig.load(fixtureEnvironment)
        assertEquals("127.0.0.1", config.listenHost)
        assertEquals(15300, config.port)
        assertEquals("http://127.0.0.1:15300", config.publicOrigin.toString())
        for (name in fixtureEnvironment.keys - setOf("SHARED_ASSET_ROOT", "SDK_ASSET_ROOT")) {
            assertTrue(Files.readString(Path.of("../shared-web/reference-app.schema.json")).contains("\"$name\""), name)
        }
        val sdk = Files.readString(Path.of("../../sdk/typescript/dist/version.json"))
        val protocol = Files.readString(Path.of("../../protocol/fixtures/v1/envelopes.json"))
        assertTrue(sdk.contains("\"protocolVersion\": \"1.0\""))
        assertTrue(protocol.contains("\"protocolVersion\": \"1.0\""))
        assertFailsWith<IllegalArgumentException> { ReferenceConfig.load(fixtureEnvironment + ("PUBLIC_ORIGIN" to "file:///tmp")) }
        assertFailsWith<IllegalArgumentException> { ReferenceConfig.load(fixtureEnvironment + ("PUBLIC_ORIGIN" to "https://example.test:443")) }
        assertFailsWith<IllegalArgumentException> { ReferenceConfig.load(fixtureEnvironment + ("ALLOWED_USERS" to "bad user")) }
    }

    @Test
    fun `health login session expiry origin and logout are safe`() = testApplication {
        val store = MemoryStore()
        val upstream = HttpClient(MockEngine { respond("{\"ticket\":\"fixture\"}", HttpStatusCode.OK) })
        application { referenceModule(ReferenceConfig.load(fixtureEnvironment), store, upstream) }

        assertEquals(HttpStatusCode.OK, client.get("/health").status)
        assertTrue(client.get("/api/diagnostics").bodyAsText().contains("Kotlin / Ktor"))
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/login") {
            contentType(ContentType.Application.Json)
            setBody("{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}")
        }.status)
        val login = client.post("/api/login") {
            header(HttpHeaders.Origin, fixtureEnvironment.getValue("PUBLIC_ORIGIN"))
            contentType(ContentType.Application.Json)
            setBody("{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}")
        }
        assertEquals(HttpStatusCode.OK, login.status)
        assertFalse(login.bodyAsText().contains("sessionId"))
        val cookie = login.headers.getAll(HttpHeaders.SetCookie)!!.first().substringBefore(';').substringAfter('=')
        assertEquals(HttpStatusCode.OK, client.get("/api/session") { cookie("cormier_session", cookie) }.status)
        store.values[store.values.keys.single()] =
            "{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\",\"allowedTopics\":[\"orders\"]," +
                "\"expiresAt\":\"${Instant.EPOCH}\",\"revoked\":false}"
        assertEquals(HttpStatusCode.Unauthorized,
            client.get("/api/session") { cookie("cormier_session", cookie) }.status)
        assertEquals(HttpStatusCode.NoContent, client.post("/api/logout") {
            header(HttpHeaders.Origin, fixtureEnvironment.getValue("PUBLIC_ORIGIN"))
            cookie("cormier_session", cookie)
        }.status)
        upstream.close()
    }

    @Test
    fun `gateway failures are generic and redacted`() = testApplication {
        val upstream = HttpClient(MockEngine { error("http://private-gateway.invalid/credential") })
        application { referenceModule(ReferenceConfig.load(fixtureEnvironment), MemoryStore(), upstream) }
        val response = client.post("/realtime/tickets") {
            header(HttpHeaders.Origin, fixtureEnvironment.getValue("PUBLIC_ORIGIN"))
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
        assertEquals(
            "{\"code\":\"service_unavailable\",\"message\":\"The reference application dependency is unavailable.\"}",
            response.bodyAsText(),
        )
        assertFalse(response.bodyAsText().contains("private-gateway"))
        upstream.close()
    }

    private class MemoryStore : SessionStore {
        val values = mutableMapOf<String, String>()
        override suspend fun ready() = true
        override suspend fun get(key: String) = values[key]
        override suspend fun put(key: String, value: String, ttlSeconds: Long) = values.put(key, value).let { true }
        override suspend fun remove(key: String) = values.remove(key) != null
        override fun close() = Unit
    }
}
