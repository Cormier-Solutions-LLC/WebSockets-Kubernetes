FROM composer:2.10.3@sha256:d8f6343d3fae98107426bc49163ccad46ef85aabd4a27d80a74401fab4aba332 AS dependencies
WORKDIR /source
COPY examples/php-laravel/composer.json examples/php-laravel/composer.lock ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader --no-scripts

FROM dunglas/frankenphp:1.12.7-php8.5-alpine@sha256:214b541fe30aeed2717d54f74149b71b2bdb0089718f1fbb8b43bc170ab00939
RUN apk add --no-cache tini=0.19.0-r3
WORKDIR /app
COPY --from=dependencies /source/vendor ./vendor
COPY examples/php-laravel/app ./app
COPY examples/php-laravel/bootstrap ./bootstrap
COPY examples/php-laravel/config ./config
COPY examples/php-laravel/public ./public
COPY examples/php-laravel/routes ./routes
COPY examples/php-laravel/artisan ./artisan
COPY examples/php-laravel/Caddyfile /etc/frankenphp/Caddyfile
COPY examples/php-laravel/start.sh ./start.sh
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
RUN mkdir -p storage/framework/sessions storage/framework/views storage/framework/cache bootstrap/cache /data/caddy /config/caddy \
    && chown -R 65532:65532 /app /data /config \
    && chmod 0555 /app/start.sh
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["/sbin/tini", "--", "/app/start.sh"]
