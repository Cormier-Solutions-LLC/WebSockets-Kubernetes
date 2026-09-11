package com.cormier.realtime.example;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
final class ReferenceErrors {
  private static final Logger LOG = LoggerFactory.getLogger(ReferenceErrors.class);

  @ExceptionHandler(ResponseStatusException.class)
  ResponseEntity<Map<String, String>> expected(ResponseStatusException error) {
    var status = error.getStatusCode();
    var code = status.value() == 403 ? "origin_rejected"
        : status.value() == 401 ? "authentication_required" : "invalid_identity";
    return ResponseEntity.status(status).body(Map.of("code", code, "message", error.getReason()));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Map<String, String>> unavailable(Exception error) {
    LOG.error("event=request_failed error={}", error.getClass().getSimpleName());
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
        "code", "service_unavailable",
        "message", "The reference application dependency is unavailable."));
  }
}
