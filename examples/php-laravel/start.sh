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
case "$LISTEN_HOST" in
  *:*) readiness_host="[$LISTEN_HOST]" ;;
  *) readiness_host="$LISTEN_HOST" ;;
esac
readiness_url="http://$readiness_host:$PORT/api/diagnostics"
while ! wget -qO- -T 1 "$readiness_url" 2>/dev/null | grep -Fq '"stack":"PHP / Laravel"'; do
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

if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid" || status=$?
  printf '%s\n' '{"event":"startup_failed","stack":"php-laravel"}' >&2
  exit "${status:-1}"
fi

printf '%s\n' '{"event":"application_started","stack":"php-laravel"}'
status=0
wait "$server_pid" || status=$?
printf '%s\n' '{"event":"application_stopped","stack":"php-laravel"}'
exit "$status"
