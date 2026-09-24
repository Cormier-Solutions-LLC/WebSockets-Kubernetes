package com.cormier.realtime.example;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.springframework.core.io.FileSystemResource;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.HttpCookie;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import tools.jackson.databind.ObjectMapper;

@RestController
public final class ReferenceController {
  private static final String COOKIE = "cormier_session";
  private final ReferenceProperties properties;
  private final ReactiveStringRedisTemplate redis;
  private final ObjectMapper json;
  private final SecureRandom random = new SecureRandom();

  ReferenceController(ReferenceProperties properties, ReactiveStringRedisTemplate redis, ObjectMapper json) {
    this.properties = properties;
    this.redis = redis;
    this.json = json;
  }

  @GetMapping("/")
  FileSystemResource index() {
    return new FileSystemResource(properties.sharedAssetRoot().resolve("index.html"));
  }

  @GetMapping("/health")
  Mono<ResponseEntity<Map<String, String>>> health() {
    return redis.hasKey(properties.redisInstancePrefix() + ":health-probe")
        .map(value -> ResponseEntity.ok(Map.of("status", "healthy")))
        .onErrorReturn(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("status", "unavailable")));
  }

  @GetMapping("/api/diagnostics")
  Mono<Map<String, Object>> diagnostics() {
    return health().map(result -> Map.of(
        "stack", "Java / Spring Boot",
        "topology", properties.topology(),
        "instance", properties.instanceName(),
        "redis", result.getStatusCode().is2xxSuccessful() ? "ready" : "unavailable",
        "heartbeatIntervalMilliseconds", properties.heartbeatIntervalMilliseconds(),
        "timestamp", Instant.now().toString()));
  }

  @PostMapping("/api/login")
  Mono<Map<String, String>> login(
      @RequestHeader(value = "Origin", required = false) String origin,
      @RequestBody LoginRequest request,
      ServerWebExchange exchange) {
    requireOrigin(origin);
    if (request == null || !properties.allows(request.tenantId(), request.userId())) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Select a configured test tenant and user.");
    }
    var bytes = new byte[24];
    random.nextBytes(bytes);
    var sessionId = HexFormat.of().formatHex(bytes);
    var expiresAt = Instant.now().plusSeconds(properties.sessionLifetimeSeconds());
    var record = new SessionRecord(request.tenantId(), request.userId(), List.of("orders", "notifications"), expiresAt, false);
    return encode(record)
        .flatMap(value -> redis.opsForValue().set(key(sessionId), value, Duration.ofSeconds(properties.sessionLifetimeSeconds())))
        .flatMap(stored -> stored ? Mono.just(record) : Mono.error(new IllegalStateException("Session was not stored.")))
        .onErrorMap(error -> unavailable())
        .map(value -> {
          exchange.getResponse().addCookie(cookie(sessionId, properties.sessionLifetimeSeconds()));
          return Map.of("tenantId", value.tenantId(), "userId", value.userId(), "expiresAt", value.expiresAt().toString());
        });
  }

  @GetMapping("/api/session")
  Mono<Map<String, Object>> session(@CookieValue(value = COOKIE, required = false) String sessionId) {
    if (sessionId == null || !sessionId.matches("[A-Za-z0-9_-]{16,256}")) return Mono.error(unauthorized());
    return redis.opsForValue().get(key(sessionId))
        .onErrorMap(error -> unavailable())
        .switchIfEmpty(Mono.error(unauthorized()))
        .flatMap(this::decode)
        .filter(record -> !record.revoked() && record.expiresAt().isAfter(Instant.now()))
        .switchIfEmpty(Mono.error(unauthorized()))
        .map(record -> Map.of(
            "authenticated", true,
            "tenantId", record.tenantId(),
            "userId", record.userId(),
            "allowedTopics", record.allowedTopics(),
            "expiresAt", record.expiresAt().toString()));
  }

  @PostMapping("/api/logout")
  Mono<ResponseEntity<Void>> logout(
      @RequestHeader(value = "Origin", required = false) String origin,
      @CookieValue(value = COOKIE, required = false) String sessionId,
      ServerWebExchange exchange) {
    requireOrigin(origin);
    var deletion = sessionId == null ? Mono.just(false) : redis.delete(key(sessionId)).map(count -> count > 0);
    return deletion.onErrorMap(error -> unavailable()).map(ignored -> {
      exchange.getResponse().addCookie(cookie("", 0));
      return ResponseEntity.noContent().build();
    });
  }

  private void requireOrigin(String origin) {
    if (!properties.publicOrigin().toString().replaceAll("/$", "").equals(origin)) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "The request Origin is not allowed.");
    }
  }

  private ResponseCookie cookie(String value, long seconds) {
    return ResponseCookie.from(COOKIE, value).httpOnly(true).secure("https".equals(properties.publicOrigin().getScheme()))
        .sameSite("Strict").path("/").maxAge(Duration.ofSeconds(seconds)).build();
  }

  private String key(String sessionId) {
    return "%s:%s:%s".formatted(properties.redisInstancePrefix(), properties.redisSessionKeyPrefix(), sessionId);
  }

  private Mono<String> encode(SessionRecord record) {
    return Mono.fromCallable(() -> json.writeValueAsString(record));
  }

  private Mono<SessionRecord> decode(String value) {
    return Mono.fromCallable(() -> json.readValue(value, SessionRecord.class));
  }

  private static ResponseStatusException unauthorized() {
    return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication is required.");
  }

  private static ResponseStatusException unavailable() {
    return new ResponseStatusException(
        HttpStatus.SERVICE_UNAVAILABLE, "The reference application dependency is unavailable.");
  }

  record LoginRequest(String tenantId, String userId) {}
  record SessionRecord(String tenantId, String userId, List<String> allowedTopics, Instant expiresAt, boolean revoked) {}
}
