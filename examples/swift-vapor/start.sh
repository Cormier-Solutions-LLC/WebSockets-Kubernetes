#!/bin/sh
set -u

failure() {
  printf '%s\n' '{"event":"startup_failed","stack":"swift-vapor"}' >&2
  exit 1
}

/app/server --env production >/dev/null &
server_pid=$!
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

attempt=0
while kill -0 "$server_pid" 2>/dev/null && kill -0 "$caddy_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 3 ] || break
  sleep 1
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
