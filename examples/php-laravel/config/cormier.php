<?php

return [
    'port' => env('PORT'),
    'public_origin' => env('PUBLIC_ORIGIN'),
    'gateway_url' => env('GATEWAY_URL'),
    'redis_url' => env('REDIS_URL'),
    'session_secret' => env('SESSION_SECRET'),
    'session_lifetime_seconds' => env('SESSION_LIFETIME_SECONDS'),
    'instance_name' => env('INSTANCE_NAME'),
    'topology' => env('TOPOLOGY'),
    'redis_instance_prefix' => env('REDIS_INSTANCE_PREFIX'),
    'redis_session_key_prefix' => env('REDIS_SESSION_KEY_PREFIX'),
    'allowed_tenants' => env('ALLOWED_TENANTS'),
    'allowed_users' => env('ALLOWED_USERS'),
    'shared_asset_root' => env('SHARED_ASSET_ROOT', dirname(__DIR__, 2).'/shared-web/wwwroot'),
    'sdk_asset_root' => env('SDK_ASSET_ROOT', dirname(__DIR__, 3).'/sdk/typescript/dist'),
];
