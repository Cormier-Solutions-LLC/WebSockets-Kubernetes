package com.cormier.realtime.example;

import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.server.WebFilter;
import org.springframework.web.reactive.config.ResourceHandlerRegistry;
import org.springframework.web.reactive.config.WebFluxConfigurer;

@SpringBootApplication
@EnableConfigurationProperties(ReferenceProperties.class)
public class ReferenceApplication {
  public static void main(String[] args) {
    SpringApplication.run(ReferenceApplication.class, args);
  }

  @Bean
  RouteLocator realtimeRoutes(RouteLocatorBuilder routes, ReferenceProperties properties) {
    var gateway = properties.gatewayUrl().toString();
    var websocket = gateway.replaceFirst("^http", "ws");
    return routes.routes()
        .route("realtime-tickets", route -> route.path("/realtime/tickets").and().method(HttpMethod.POST)
            .filters(filters -> filters.preserveHostHeader())
            .uri(gateway))
        .route("realtime-websocket", route -> route.path("/realtime/ws")
            .filters(filters -> filters.preserveHostHeader())
            .uri(websocket))
        .build();
  }

  @Bean
  WebFilter securityBoundary(ReferenceProperties properties) {
    return (exchange, chain) -> {
      var response = exchange.getResponse();
      var headers = response.getHeaders();
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'");
      var path = exchange.getRequest().getPath().value();
      if (path.equals("/health") || path.startsWith("/api/") || path.startsWith("/realtime/")) {
        headers.setCacheControl(CacheControl.noStore());
      }
      if (exchange.getRequest().getMethod() == HttpMethod.POST
          && path.equals("/realtime/tickets")
          && !properties.publicOrigin().toString().replaceAll("/$", "")
              .equals(exchange.getRequest().getHeaders().getOrigin())) {
        response.setStatusCode(HttpStatus.FORBIDDEN);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        var body = "{\"code\":\"origin_rejected\",\"message\":\"The request Origin is not allowed.\"}".getBytes(StandardCharsets.UTF_8);
        return response.writeWith(reactor.core.publisher.Mono.just(response.bufferFactory().wrap(body)));
      }
      return chain.filter(exchange);
    };
  }

  @Bean
  WebFluxConfigurer canonicalAssets(ReferenceProperties properties) {
    return new WebFluxConfigurer() {
      @Override
      public void addResourceHandlers(ResourceHandlerRegistry registry) {
        add(registry, "/app.css", properties.sharedAssetRoot());
        add(registry, "/app.js", properties.sharedAssetRoot());
        add(registry, "/_content/Cormier.Realtime.Browser/**", properties.sdkAssetRoot());
      }

      private void add(ResourceHandlerRegistry registry, String route, Path root) {
        var location = root.toAbsolutePath().normalize().toUri().toString();
        registry.addResourceHandler(route)
            .addResourceLocations(location)
            .setCacheControl(CacheControl.noStore())
            .resourceChain(false);
      }
    };
  }
}
