package com.cormier.realtime.example;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.ReactiveValueOperations;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;

@SpringBootTest(properties = {
    "LISTEN_HOST=127.0.0.1",
    "PORT=15200",
    "server.port=0",
    "PUBLIC_ORIGIN=http://127.0.0.1:15200",
    "GATEWAY_URL=http://127.0.0.1:9",
    "REDIS_URL=redis://127.0.0.1:6379",
    "SESSION_LIFETIME_SECONDS=1200",
    "HEARTBEAT_INTERVAL_MILLISECONDS=5000",
    "INSTANCE_NAME=java-spring-a",
    "TOPOLOGY=non-ha",
    "REDIS_INSTANCE_PREFIX=cormier:java-test",
    "REDIS_SESSION_KEY_PREFIX=sessions",
    "ALLOWED_TENANTS=tenant-a,tenant-b",
    "ALLOWED_USERS=user-a,user-b"
})
@AutoConfigureWebTestClient
final class ReferenceApplicationTests {
  @Autowired private WebTestClient client;
  @MockitoBean private ReactiveStringRedisTemplate redis;
  @MockitoBean private ReactiveValueOperations<String, String> values;
  @Autowired private RouteLocator routes;
  @Autowired private ReferenceProperties properties;

  @BeforeEach
  void configureRedis() {
    when(redis.hasKey(anyString())).thenReturn(Mono.just(false));
    when(redis.opsForValue()).thenReturn(values);
    when(values.set(anyString(), anyString(), any(Duration.class))).thenReturn(Mono.just(true));
    when(redis.delete(anyString())).thenReturn(Mono.just(1L));
  }

  @Test
  void exposesHealthDiagnosticsAndCanonicalAssets() {
    org.junit.jupiter.api.Assertions.assertEquals(15200, properties.port());
    client.get().uri("/health").exchange().expectStatus().isOk()
        .expectBody().jsonPath("$.status").isEqualTo("healthy");
    client.get().uri("/api/diagnostics").exchange().expectStatus().isOk()
        .expectHeader().cacheControl(CacheControl.noStore())
        .expectBody().jsonPath("$.stack").isEqualTo("Java / Spring Boot")
        .jsonPath("$.redis").isEqualTo("ready")
        .jsonPath("$.heartbeatIntervalMilliseconds").isEqualTo(5000);
    client.get().uri("/").exchange().expectStatus().isOk()
        .expectHeader().contentTypeCompatibleWith(MediaType.TEXT_HTML);
    client.get().uri("/app.js").exchange().expectStatus().isOk();
  }

  @Test
  void rejectsMissingOriginAndUnknownIdentity() {
    client.post().uri("/api/login").contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}")
        .exchange().expectStatus().isForbidden()
        .expectBody().jsonPath("$.code").isEqualTo("origin_rejected");
    client.post().uri("/api/login").header("Origin", "http://127.0.0.1:15200")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"tenantId\":\"tenant-a\",\"userId\":\"unknown\"}")
        .exchange().expectStatus().isBadRequest()
        .expectBody().jsonPath("$.code").isEqualTo("invalid_identity");
  }

  @Test
  void rejectsMalformedLoginAsAClientError() {
    client.post().uri("/api/login").header("Origin", "http://127.0.0.1:15200")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{not-json")
        .exchange().expectStatus().isBadRequest()
        .expectBody().jsonPath("$.code").isEqualTo("invalid_request");
  }

  @Test
  void rejectsOversizedLoginAsAClientError() {
    var body = "{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}" + " ".repeat(64 * 1024);
    client.post().uri("/api/login").header("Origin", "http://127.0.0.1:15200")
        .contentType(MediaType.APPLICATION_JSON).bodyValue(body)
        .exchange().expectStatus().isEqualTo(413)
        .expectBody().jsonPath("$.code").isEqualTo("invalid_request");
  }

  @Test
  void createsGatewayCompatibleSessionAndLogsOut() {
    client.post().uri("/api/login").header("Origin", "http://127.0.0.1:15200")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}")
        .exchange().expectStatus().isOk()
        .expectCookie().httpOnly("cormier_session", true)
        .expectCookie().sameSite("cormier_session", "Strict")
        .expectBody().jsonPath("$.tenantId").isEqualTo("tenant-a")
        .jsonPath("$.sessionId").doesNotExist();
    client.post().uri("/api/logout").header("Origin", "http://127.0.0.1:15200")
        .exchange().expectStatus().isNoContent()
        .expectCookie().maxAge("cormier_session", Duration.ZERO);
  }

  @Test
  void rejectsExpiredSessions() throws Exception {
    var expired = "{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\",\"allowedTopics\":[\"orders\"],"
        + "\"expiresAt\":\"" + Instant.EPOCH + "\",\"revoked\":false}";
    when(values.get(anyString())).thenReturn(Mono.just(expired));
    client.get().uri("/api/session").cookie("cormier_session", "0123456789abcdef")
        .exchange().expectStatus().isUnauthorized()
        .expectBody().jsonPath("$.code").isEqualTo("authentication_required");
  }

  @Test
  void returnsRedactedDependencyAndGatewayFailures() {
    when(values.set(anyString(), anyString(), any(Duration.class)))
        .thenReturn(Mono.error(new IllegalStateException("redis://user:secret@private.invalid")));
    client.post().uri("/api/login").header("Origin", "http://127.0.0.1:15200")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"tenantId\":\"tenant-a\",\"userId\":\"user-a\"}")
        .exchange().expectStatus().isEqualTo(503)
        .expectBody().json("{\"code\":\"service_unavailable\",\"message\":\"The reference application dependency is unavailable.\"}")
        .consumeWith(result -> org.junit.jupiter.api.Assertions.assertFalse(
            new String(result.getResponseBody()).contains("private.invalid")));

    when(values.get(anyString()))
        .thenReturn(Mono.error(new IllegalStateException("redis://user:secret@private.invalid")));
    client.get().uri("/api/session").cookie("cormier_session", "0123456789abcdef")
        .exchange().expectStatus().isEqualTo(503)
        .expectBody().jsonPath("$.code").isEqualTo("service_unavailable");

    when(redis.delete(anyString()))
        .thenReturn(Mono.error(new IllegalStateException("redis://user:secret@private.invalid")));
    client.post().uri("/api/logout").header("Origin", "http://127.0.0.1:15200")
        .cookie("cormier_session", "0123456789abcdef")
        .exchange().expectStatus().isEqualTo(503)
        .expectBody().jsonPath("$.code").isEqualTo("service_unavailable");

    client.post().uri("/realtime/tickets").header("Origin", "http://127.0.0.1:15200")
        .exchange().expectStatus().is5xxServerError()
        .expectBody().consumeWith(result -> org.junit.jupiter.api.Assertions.assertFalse(
            new String(result.getResponseBody()).contains("127.0.0.1:9")));
  }

  @Test
  void consumesCanonicalConfigurationAndProtocolContracts() throws Exception {
    var mapper = new tools.jackson.databind.ObjectMapper();
    var schema = mapper.readTree(Files.readString(Path.of("../shared-web/reference-app.schema.json")));
    var required = schema.get("required").toString();
    for (var name : new String[] { "LISTEN_HOST", "PUBLIC_ORIGIN", "GATEWAY_URL", "REDIS_URL", "SESSION_LIFETIME_SECONDS", "HEARTBEAT_INTERVAL_MILLISECONDS",
        "INSTANCE_NAME", "TOPOLOGY", "REDIS_INSTANCE_PREFIX", "REDIS_SESSION_KEY_PREFIX", "ALLOWED_TENANTS",
        "ALLOWED_USERS" }) {
      org.junit.jupiter.api.Assertions.assertTrue(required.contains("\"" + name + "\""), name);
    }
    var sdk = mapper.readTree(Files.readString(Path.of("../../sdk/typescript/dist/version.json")));
    var protocol = mapper.readTree(Files.readString(Path.of("../../protocol/fixtures/v1/envelopes.json")));
    org.junit.jupiter.api.Assertions.assertEquals("1.0", sdk.get("protocolVersion").asText());
    org.junit.jupiter.api.Assertions.assertEquals(sdk.get("protocolVersion"), protocol.get("protocolVersion"));
  }

  @Test
  void ticketRouteHasFiniteResponseTimeout() {
    var route = routes.getRoutes().filter(candidate -> candidate.getId().equals("realtime-tickets"))
        .blockFirst(Duration.ofSeconds(1));
    org.junit.jupiter.api.Assertions.assertNotNull(route);
    org.junit.jupiter.api.Assertions.assertEquals(15_000L, route.getMetadata().get("response-timeout"));
  }

  @Test
  void rejectsExplicitDefaultOriginPorts() {
    var properties = new ReferenceProperties(
        "127.0.0.1", 15200, URI.create("https://example.test:443"), URI.create("http://gateway.test"),
        1200, 5000, "java-spring-a", "non-ha", "cormier:java-test", "sessions",
        java.util.List.of("tenant-a"), java.util.List.of("user-a"), Path.of("."), Path.of("."));
    org.junit.jupiter.api.Assertions.assertFalse(properties.areOriginsValid());

    properties = new ReferenceProperties(
        "127.0.0.1", 15200, URI.create("https://EXAMPLE.TEST"), URI.create("http://gateway.test"),
        1200, 5000, "java-spring-a", "non-ha", "cormier:java-test", "sessions",
        java.util.List.of("tenant-a"), java.util.List.of("user-a"), Path.of("."), Path.of("."));
    org.junit.jupiter.api.Assertions.assertFalse(properties.areOriginsValid());

    properties = new ReferenceProperties(
        "127.0.0.1", 15200, URI.create("https://example.test:99999"), URI.create("http://gateway.test"),
        1200, 5000, "java-spring-a", "non-ha", "cormier:java-test", "sessions",
        java.util.List.of("tenant-a"), java.util.List.of("user-a"), Path.of("."), Path.of("."));
    org.junit.jupiter.api.Assertions.assertFalse(properties.areOriginsValid());
  }

  @Test
  void rejectsMalformedOriginHostsAndAcceptsFullIpLiterals() {
    for (var name : new String[] { "a..b", "-bad.example", "bad-.example", "999.999.999.999", "127.1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example", "[fe80::1%25eth0]" }) {
      var properties = new ReferenceProperties(
          "127.0.0.1", 15200, URI.create("https://" + name), URI.create("http://gateway.test"),
          1200, 5000, "java-spring-a", "non-ha", "cormier:java-test", "sessions",
          java.util.List.of("tenant-a"), java.util.List.of("user-a"), Path.of("."), Path.of("."));
      org.junit.jupiter.api.Assertions.assertFalse(properties.areOriginsValid(), name);
    }
    var properties = new ReferenceProperties(
        "127.0.0.1", 15200, URI.create("https://[::1]"), URI.create("http://192.0.2.1:15501"),
        1200, 5000, "java-spring-a", "non-ha", "cormier:java-test", "sessions",
        java.util.List.of("tenant-a"), java.util.List.of("user-a"), Path.of("."), Path.of("."));
    org.junit.jupiter.api.Assertions.assertTrue(properties.areOriginsValid());
  }
}
