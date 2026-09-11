<?php

namespace App;

use InvalidArgumentException;

final readonly class ReferenceConfig
{
    /** @param list<string> $allowedTenants @param list<string> $allowedUsers */
    private function __construct(
        public int $port,
        public string $publicOrigin,
        public string $gatewayUrl,
        public string $redisUrl,
        public int $sessionLifetimeSeconds,
        public string $instanceName,
        public string $topology,
        public string $redisInstancePrefix,
        public string $redisSessionKeyPrefix,
        public array $allowedTenants,
        public array $allowedUsers,
        public string $sharedAssetRoot,
        public string $sdkAssetRoot,
    ) {}

    /** @param array<string, mixed> $values */
    public static function fromArray(array $values): self
    {
        $required = static function (string $name) use ($values): string {
            $value = $values[$name] ?? null;
            if (! is_string($value) || trim($value) === '') {
                throw new InvalidArgumentException('Required configuration is missing.');
            }

            return $value;
        };
        $port = filter_var($required('port'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1024, 'max_range' => 65535]]);
        $lifetime = filter_var($required('session_lifetime_seconds'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 60, 'max_range' => 7200]]);
        if ($port === false || $lifetime === false) {
            throw new InvalidArgumentException('Numeric configuration is invalid.');
        }
        $origin = self::origin($required('public_origin'));
        $gateway = self::origin($required('gateway_url'));
        $redis = parse_url($required('redis_url'));
        if ($redis === false || ! in_array($redis['scheme'] ?? '', ['redis', 'rediss'], true) || empty($redis['host']) || isset($redis['fragment'])) {
            throw new InvalidArgumentException('Redis configuration is invalid.');
        }
        $identifier = '/^[A-Za-z0-9._-]{1,128}$/D';
        $prefix = '/^[A-Za-z0-9._:-]{1,128}$/D';
        $instance = $required('instance_name');
        $topology = $required('topology');
        $instancePrefix = $required('redis_instance_prefix');
        $sessionPrefix = $required('redis_session_key_prefix');
        if (! preg_match($identifier, $instance) || ! in_array($topology, ['ha', 'non-ha'], true)
            || ! preg_match($prefix, $instancePrefix) || ! preg_match($identifier, $sessionPrefix)) {
            throw new InvalidArgumentException('Identifier configuration is invalid.');
        }
        $secret = $required('session_secret');
        if (strlen($secret) < 32 || strlen($secret) > 4096) {
            throw new InvalidArgumentException('Session configuration is invalid.');
        }
        $list = static function (string $name) use ($required, $identifier): array {
            $items = array_map('trim', explode(',', $required($name)));
            if ($items === [] || array_any($items, fn (string $item): bool => ! preg_match($identifier, $item))) {
                throw new InvalidArgumentException('Allowlist configuration is invalid.');
            }

            return array_values(array_unique($items));
        };

        return new self(
            $port,
            $origin,
            $gateway,
            $required('redis_url'),
            $lifetime,
            $instance,
            $topology,
            $instancePrefix,
            $sessionPrefix,
            $list('allowed_tenants'),
            $list('allowed_users'),
            $required('shared_asset_root'),
            $required('sdk_asset_root'),
        );
    }

    private static function origin(string $value): string
    {
        $parsed = parse_url($value);
        if ($parsed === false || ! in_array($parsed['scheme'] ?? '', ['http', 'https'], true) || empty($parsed['host'])
            || isset($parsed['user'], $parsed['query'], $parsed['fragment']) || ! in_array($parsed['path'] ?? '', ['', '/'], true)) {
            throw new InvalidArgumentException('Origin configuration is invalid.');
        }

        return rtrim($value, '/');
    }

    public function allows(string $tenant, string $user): bool
    {
        return in_array($tenant, $this->allowedTenants, true) && in_array($user, $this->allowedUsers, true);
    }

    public function sessionKey(string $id): string
    {
        return "$this->redisInstancePrefix:$this->redisSessionKeyPrefix:$id";
    }
}
