package com.cormier.realtime.example;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebInputException;

@RestControllerAdvice
final class ReferenceErrors {
  private static final Logger LOG = LoggerFactory.getLogger(ReferenceErrors.class);

  @ExceptionHandler(ResponseStatusException.class)
  ResponseEntity<Map<String, String>> expected(ResponseStatusException error) {
    var status = error.getStatusCode();
    var code = status.value() == 503 ? "service_unavailable"
        : status.value() == 403 ? "origin_rejected"
        : status.value() == 401 ? "authentication_required"
        : status.value() == 413 ? "invalid_request" : "invalid_identity";
    var message = status.value() == 413 ? "The request body is invalid."
        : error.getReason() == null ? "The request is invalid." : error.getReason();
    return ResponseEntity.status(status).body(Map.of("code", code, "message", message));
  }

  @ExceptionHandler({ServerWebInputException.class, DataBufferLimitException.class})
  ResponseEntity<Map<String, String>> invalidRequest(Exception error) {
    var status = causedBy(error, DataBufferLimitException.class)
        ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
    return ResponseEntity.status(status).body(Map.of(
        "code", "invalid_request",
        "message", "The request body is invalid."));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Map<String, String>> unavailable(Exception error) {
    LOG.error("event=request_failed error={}", error.getClass().getSimpleName());
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
        "code", "service_unavailable",
        "message", "The reference application dependency is unavailable."));
  }

  private static boolean causedBy(Throwable error, Class<? extends Throwable> type) {
    for (var current = error; current != null; current = current.getCause()) {
      if (type.isInstance(current)) {
        return true;
      }
    }
    return false;
  }
}
