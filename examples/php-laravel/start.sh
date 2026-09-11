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
printf '%s\n' '{"event":"application_started","stack":"php-laravel"}'
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
status=0
wait "$server_pid" || status=$?
printf '%s\n' '{"event":"application_stopped","stack":"php-laravel"}'
exit "$status"
