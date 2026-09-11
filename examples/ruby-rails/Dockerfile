FROM ruby:4.0.6-alpine3.24@sha256:6ec7aeb4f3f0b67a21fb73a83fc20a4055696e64b933229f68ec805a3de38fcc AS dependencies
RUN apk add --no-cache build-base yaml-dev
RUN gem install bundler -v 4.0.20 --no-document
WORKDIR /source
COPY examples/ruby-rails/Gemfile examples/ruby-rails/Gemfile.lock ./
RUN bundle _4.0.20_ config set deployment true \
    && bundle _4.0.20_ config set without development:test \
    && bundle _4.0.20_ config set path /bundle \
    && bundle _4.0.20_ install --jobs 4 --retry 3

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
FROM ruby:4.0.6-alpine3.24@sha256:6ec7aeb4f3f0b67a21fb73a83fc20a4055696e64b933229f68ec805a3de38fcc
RUN apk add --no-cache tini=0.19.0-r3 tzdata yaml libstdc++
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=dependencies /usr/local/bundle /usr/local/bundle
COPY --from=dependencies /bundle /bundle
WORKDIR /app
COPY examples/ruby-rails/app ./app
COPY examples/ruby-rails/bin ./bin
COPY examples/ruby-rails/config ./config
COPY examples/ruby-rails/lib ./lib
COPY examples/ruby-rails/Gemfile examples/ruby-rails/Gemfile.lock examples/ruby-rails/Rakefile examples/ruby-rails/config.ru ./
COPY examples/ruby-rails/Caddyfile /etc/caddy/Caddyfile
COPY examples/ruby-rails/start.sh ./start.sh
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
RUN mkdir -p /data/caddy /config/caddy tmp/pids \
    && chown -R 65532:65532 /app /data /config /tmp \
    && chmod 0555 /app/start.sh
ENV BUNDLE_DEPLOYMENT=true
ENV BUNDLE_WITHOUT=development:test
ENV BUNDLE_PATH=/bundle
ENV RAILS_ENV=production
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["/sbin/tini", "--", "/app/start.sh"]
