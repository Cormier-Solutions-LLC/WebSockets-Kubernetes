<?php

$secret = (string) env('SESSION_SECRET', '');

return [
    'name' => 'Cormier.Realtime Laravel Example',
    'env' => env('APP_ENV', 'production'),
    'debug' => false,
    'url' => env('PUBLIC_ORIGIN'),
    'timezone' => 'UTC',
    'locale' => 'en',
    'fallback_locale' => 'en',
    'cipher' => 'AES-256-CBC',
    'key' => 'base64:'.base64_encode(hash('sha256', $secret, true)),
    'maintenance' => ['driver' => 'file', 'store' => 'database'],
];
