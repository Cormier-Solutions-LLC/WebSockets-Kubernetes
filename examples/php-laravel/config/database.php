<?php

return [
    'default' => 'sqlite',
    'connections' => [
        'sqlite' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => ''],
    ],
    'redis' => [
        'client' => 'predis',
        'options' => ['prefix' => ''],
        'default' => [
            'url' => env('REDIS_URL'),
            'timeout' => 5.0,
            'read_timeout' => 5.0,
            'read_write_timeout' => 5.0,
        ],
    ],
];
