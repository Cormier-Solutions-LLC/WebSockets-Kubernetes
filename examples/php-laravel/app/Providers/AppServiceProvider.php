<?php

namespace App\Providers;

use App\ReferenceConfig;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(ReferenceConfig::class, fn (): ReferenceConfig => ReferenceConfig::fromArray(config('cormier')));
    }
}
