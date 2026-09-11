#!/bin/sh
set -u

failure() {
  [ -z "${caddy_pid:-}" ] || kill -TERM "$caddy_pid" 2>/dev/null || true
  [ -z "${puma_pid:-}" ] || kill -TERM "$puma_pid" 2>/dev/null || true
  printf '%s\n' '{"event":"startup_failed","stack":"ruby-rails"}' >&2
  exit 1
}

bundle exec rails runner 'raise "asset" unless ["index.html", "app.css", "app.js"].map { |name| Rails.configuration.x.reference.shared_asset_root + "/" + name }.concat(["cormier-realtime.iife.js", "cormier-realtime.iife.min.js"].map { |name| Rails.configuration.x.reference.sdk_asset_root + "/" + name }).all? { |path| File.file?(path) }' >/dev/null 2>&1 || failure
case "${PUBLIC_ORIGIN:-}" in
  http://*) PUBLIC_SCHEME=http ;;
  https://*) PUBLIC_SCHEME=https ;;
  *) failure ;;
esac
export PUBLIC_SCHEME
rm -f /tmp/cormier-rails.sock
bundle exec puma --config config/puma.rb >/dev/null &
puma_pid=$!

attempt=0
while [ ! -S /tmp/cormier-rails.sock ]; do
  kill -0 "$puma_pid" 2>/dev/null || failure
  attempt=$((attempt + 1))
  [ "$attempt" -lt 150 ] || failure
  sleep 0.1
done

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

case "$LISTEN_HOST" in
  *:*) readiness_host="[$LISTEN_HOST]" ;;
  *) readiness_host="$LISTEN_HOST" ;;
esac
readiness_url="http://$readiness_host:$PORT/api/diagnostics"
public_authority=${PUBLIC_ORIGIN#*://}
public_authority=${public_authority%%/*}
attempt=0
while ! wget -qO- -T 1 --header "Host: $public_authority" "$readiness_url" 2>/dev/null | ruby -rjson -e 'payload = JSON.parse($stdin.read); exit(payload["stack"] == "Ruby / Rails" ? 0 : 1)' 2>/dev/null; do
  kill -0 "$caddy_pid" 2>/dev/null || failure
  kill -0 "$puma_pid" 2>/dev/null || failure
  attempt=$((attempt + 1))
  [ "$attempt" -lt 150 ] || failure
  sleep 0.1
done
kill -0 "$caddy_pid" 2>/dev/null || failure
kill -0 "$puma_pid" 2>/dev/null || failure
printf '%s\n' '{"event":"application_started","stack":"ruby-rails"}'

terminate() {
  kill -TERM "$caddy_pid" "$puma_pid" 2>/dev/null || true
  wait "$caddy_pid" 2>/dev/null || true
  wait "$puma_pid" 2>/dev/null || true
  printf '%s\n' '{"event":"application_stopped","stack":"ruby-rails"}'
  exit 0
}

trap terminate TERM INT
while kill -0 "$caddy_pid" 2>/dev/null && kill -0 "$puma_pid" 2>/dev/null; do
  sleep 1
done
failure
