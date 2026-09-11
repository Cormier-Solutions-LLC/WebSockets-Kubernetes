<?php

return [
    'driver' => 'array',
    'lifetime' => 20,
    'expire_on_close' => true,
    'encrypt' => true,
    'files' => storage_path('framework/sessions'),
    'connection' => null,
    'table' => 'sessions',
    'store' => null,
    'lottery' => [0, 100],
    'cookie' => 'laravel_reference_session',
    'path' => '/',
    'domain' => null,
    'secure' => null,
    'http_only' => true,
    'same_site' => 'strict',
    'partitioned' => false,
];
