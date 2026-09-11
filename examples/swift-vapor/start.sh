#!/bin/sh
set -u

failure() {
  [ -z "${caddy_pid:-}" ] || kill -TERM "$caddy_pid" 2>/dev/null || true
  [ -z "${server_pid:-}" ] || kill -TERM "$server_pid" 2>/dev/null || true
  printf '%s\n' '{"event":"startup_failed","stack":"swift-vapor"}' >&2
  exit 1
}

case "${PUBLIC_ORIGIN:-}" in
  http://*) PUBLIC_SCHEME=http ;;
  https://*) PUBLIC_SCHEME=https ;;
  *) failure ;;
esac
export PUBLIC_SCHEME

/app/server --env production >/dev/null &
server_pid=$!
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
while ! curl --fail --silent --show-error --max-time 1 --header "Host: $public_authority" "$readiness_url" 2>/dev/null | grep -F '"stack":"Swift' >/dev/null; do
  kill -0 "$server_pid" 2>/dev/null || failure
  kill -0 "$caddy_pid" 2>/dev/null || failure
  attempt=$((attempt + 1))
  [ "$attempt" -lt 150 ] || failure
  sleep 0.1
done
kill -0 "$server_pid" 2>/dev/null || failure
kill -0 "$caddy_pid" 2>/dev/null || failure
printf '%s\n' '{"event":"application_started","stack":"swift-vapor"}'

terminate() {
  kill -TERM "$caddy_pid" "$server_pid" 2>/dev/null || true
  wait "$caddy_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  printf '%s\n' '{"event":"application_stopped","stack":"swift-vapor"}'
  exit 0
}

trap terminate TERM INT
while kill -0 "$caddy_pid" 2>/dev/null && kill -0 "$server_pid" 2>/dev/null; do
  sleep 1
done
failure
