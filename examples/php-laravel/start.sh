#!/bin/sh
set -eu

if ! php artisan app:preflight; then
  printf '%s\n' '{"event":"startup_failed","stack":"php-laravel"}' >&2
  exit 1
fi
case "$PUBLIC_ORIGIN" in
  http://*) PUBLIC_SCHEME=http ;;
  https://*) PUBLIC_SCHEME=https ;;
  *) exit 1 ;;
esac
export PUBLIC_SCHEME
frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile &
server_pid=$!

terminate() {
  kill -TERM "$server_pid" 2>/dev/null || true
  status=0
  wait "$server_pid" || status=$?
  printf '%s\n' '{"event":"application_stopped","stack":"php-laravel"}'
  exit "$status"
}

trap terminate TERM INT

attempt=0
while ! nc -z "$LISTEN_HOST" "$PORT" >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    status=0
    wait "$server_pid" || status=$?
    printf '%s\n' '{"event":"startup_failed","stack":"php-laravel"}' >&2
    [ "$status" -ne 0 ] || status=1
    exit "$status"
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 150 ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    printf '%s\n' '{"event":"startup_failed","stack":"php-laravel"}' >&2
    exit 1
  fi
  sleep 0.1
done

printf '%s\n' '{"event":"application_started","stack":"php-laravel"}'
status=0
wait "$server_pid" || status=$?
printf '%s\n' '{"event":"application_stopped","stack":"php-laravel"}'
exit "$status"
