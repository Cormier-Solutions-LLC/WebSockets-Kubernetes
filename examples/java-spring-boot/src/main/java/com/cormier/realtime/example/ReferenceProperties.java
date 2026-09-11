package com.cormier.realtime.example;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("cormier.reference")
public record ReferenceProperties(
    @NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,253}") String listenHost,
    URI publicOrigin,
    URI gatewayUrl,
    @Min(60) @Max(7200) int sessionLifetimeSeconds,
    @NotBlank @Pattern(regexp = "[A-Za-z0-9._-]{1,128}") String instanceName,
    @Pattern(regexp = "ha|non-ha") String topology,
    @NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,128}") String redisInstancePrefix,
    @NotBlank @Pattern(regexp = "[A-Za-z0-9._-]{1,128}") String redisSessionKeyPrefix,
    @Size(min = 1) List<@Pattern(regexp = "[A-Za-z0-9._-]{1,128}") String> allowedTenants,
    @Size(min = 1) List<@Pattern(regexp = "[A-Za-z0-9._-]{1,128}") String> allowedUsers,
    Path sharedAssetRoot,
    Path sdkAssetRoot) {

  @AssertTrue(message = "PUBLIC_ORIGIN and GATEWAY_URL must be HTTP(S) origins without credentials, paths, queries, or fragments")
  public boolean areOriginsValid() {
    return isOrigin(publicOrigin) && isOrigin(gatewayUrl);
  }

  private static boolean isOrigin(URI value) {
    return value != null
        && ("http".equals(value.getScheme()) || "https".equals(value.getScheme()))
        && value.getHost() != null
        && value.toString().equals(value.toString().toLowerCase(java.util.Locale.ROOT))
        && value.getUserInfo() == null
        && (value.getPath() == null || value.getPath().isEmpty() || "/".equals(value.getPath()))
        && value.getQuery() == null
        && value.getFragment() == null
        && (value.getPort() == -1 || value.getPort() >= 1 && value.getPort() <= 65535)
        && !("http".equals(value.getScheme()) && value.getPort() == 80)
        && !("https".equals(value.getScheme()) && value.getPort() == 443);
  }

  public boolean allows(String tenantId, String userId) {
    return allowedTenants.contains(tenantId) && allowedUsers.contains(userId);
  }
}
