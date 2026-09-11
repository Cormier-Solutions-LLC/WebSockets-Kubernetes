<?php

namespace Tests\Unit;

use App\ReferenceConfig;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ReferenceConfigTest extends TestCase
{
    /** @return array<string, string> */
    private function values(): array
    {
        return [
            'listen_host' => '127.0.0.1', 'port' => '15500', 'public_origin' => 'http://127.0.0.1:15500', 'gateway_url' => 'http://127.0.0.1:15501',
            'redis_url' => 'redis://127.0.0.1:6379', 'session_secret' => str_repeat('x', 32), 'session_lifetime_seconds' => '1200',
            'instance_name' => 'php-laravel-a', 'topology' => 'non-ha', 'redis_instance_prefix' => 'cormier:test',
            'redis_session_key_prefix' => 'sessions', 'allowed_tenants' => 'tenant-a', 'allowed_users' => 'user-a',
            'shared_asset_root' => __DIR__, 'sdk_asset_root' => __DIR__,
        ];
    }

    public function test_it_parses_typed_configuration(): void
    {
        $config = ReferenceConfig::fromArray($this->values());
        self::assertSame('127.0.0.1', $config->listenHost);
        self::assertSame(15500, $config->port);
        self::assertTrue($config->allows('tenant-a', 'user-a'));
        self::assertSame('cormier:test:sessions:id', $config->sessionKey('id'));
        self::assertSame('http', $config->publicScheme());
    }

    public function test_it_rejects_unsafe_origins(): void
    {
        $values = $this->values();
        $values['public_origin'] = 'file:///tmp';
        $this->expectException(InvalidArgumentException::class);
        ReferenceConfig::fromArray($values);
    }

    public function test_it_rejects_explicit_default_origin_ports(): void
    {
        $values = $this->values();
        $values['public_origin'] = 'https://example.test:443';
        $this->expectException(InvalidArgumentException::class);
        ReferenceConfig::fromArray($values);
    }

    public function test_it_rejects_noncanonical_origin_casing(): void
    {
        $values = $this->values();
        $values['public_origin'] = 'https://EXAMPLE.TEST';
        $this->expectException(InvalidArgumentException::class);
        ReferenceConfig::fromArray($values);
    }

    #[DataProvider('forbiddenOriginProvider')]
    public function test_it_rejects_each_forbidden_origin_component(string $origin): void
    {
        $values = $this->values();
        $values['public_origin'] = $origin;
        $this->expectException(InvalidArgumentException::class);
        ReferenceConfig::fromArray($values);
    }

    /** @return array<string, array{string}> */
    public static function forbiddenOriginProvider(): array
    {
        return [
            'credentials' => ['https://user:password@example.test'],
            'query' => ['https://example.test?route=unsafe'],
            'fragment' => ['https://example.test#unsafe'],
        ];
    }

    public function test_it_consumes_canonical_contracts(): void
    {
        $schema = file_get_contents(__DIR__.'/../../../shared-web/reference-app.schema.json');
        $sdk = file_get_contents(__DIR__.'/../../../../sdk/typescript/dist/version.json');
        $protocol = file_get_contents(__DIR__.'/../../../../protocol/fixtures/v1/envelopes.json');
        self::assertIsString($schema);
        foreach (['LISTEN_HOST', 'PORT', 'PUBLIC_ORIGIN', 'GATEWAY_URL', 'REDIS_URL', 'SESSION_SECRET', 'PUBLIC_ROOT'] as $key) {
            self::assertStringContainsString('"'.$key.'"', $schema);
        }
        self::assertStringContainsString('"protocolVersion": "1.0"', (string) $sdk);
        self::assertStringContainsString('"protocolVersion": "1.0"', (string) $protocol);
    }

    public function test_caddy_rejects_oversized_login_and_ticket_bodies_before_php_buffers_them(): void
    {
        $caddyfile = file_get_contents(__DIR__.'/../../Caddyfile');
        self::assertIsString($caddyfile);
        self::assertStringContainsString('@bounded_request path /api/login /realtime/tickets', $caddyfile);
        self::assertStringContainsString('request_body @bounded_request', $caddyfile);
        self::assertStringContainsString('max_size 65536', $caddyfile);
        self::assertStringContainsString('header_up X-Forwarded-Proto {$PUBLIC_SCHEME}', $caddyfile);
    }

    public function test_preflight_checks_the_loaded_sdk_and_started_log_follows_listener_readiness(): void
    {
        $preflight = file_get_contents(__DIR__.'/../../routes/console.php');
        $startup = file_get_contents(__DIR__.'/../../start.sh');
        self::assertIsString($preflight);
        self::assertIsString($startup);
        self::assertStringContainsString('cormier-realtime.iife.js', $preflight);
        self::assertStringNotContainsString('cormier-realtime.iife.min.js', $preflight);
        self::assertStringContainsString('readiness_url="http://$readiness_host:$PORT/api/diagnostics"', $startup);
        self::assertStringContainsString('json_decode(stream_get_contents(STDIN), true)', $startup);
        self::assertStringContainsString('=== "PHP / Laravel"', $startup);
        self::assertStringContainsString('if ! kill -0 "$server_pid"', $startup);
        self::assertStringContainsString('[ "$attempt" -ge 150 ]', $startup);
        self::assertLessThan(
            strpos($startup, 'application_started'),
            strpos($startup, 'readiness_url=')
        );
    }

    public function test_ticket_response_is_streamed_through_a_strict_limit(): void
    {
        $controller = file_get_contents(__DIR__.'/../../app/Http/Controllers/ReferenceController.php');
        self::assertIsString($controller);
        self::assertStringContainsString("withOptions(['stream' => true])", $controller);
        self::assertStringContainsString('MAXIMUM_BODY_BYTES + 1 - strlen($body)', $controller);
        self::assertStringNotContainsString('response($upstream->body()', $controller);
    }
}
