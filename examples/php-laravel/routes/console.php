<?php

use App\ReferenceConfig;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Redis;

Artisan::command('app:preflight', function (ReferenceConfig $config): int {
    try {
        Redis::connection()->ping();
        foreach ([$config->sharedAssetRoot.'/index.html', $config->sharedAssetRoot.'/app.css', $config->sharedAssetRoot.'/app.js', $config->sdkAssetRoot.'/cormier-realtime.iife.js'] as $path) {
            if (! is_file($path)) {
                throw new RuntimeException('Required asset is unavailable.');
            }
        }
        $this->line(json_encode(['event' => 'preflight_complete', 'stack' => 'php-laravel'], JSON_THROW_ON_ERROR));

        return self::SUCCESS;
    } catch (Throwable) {
        $this->error(json_encode(['event' => 'startup_failed', 'stack' => 'php-laravel'], JSON_THROW_ON_ERROR));

        return self::FAILURE;
    }
});
