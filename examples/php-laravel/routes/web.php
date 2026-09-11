<?php

use App\Http\Controllers\ReferenceController;
use App\ReferenceConfig;
use Illuminate\Support\Facades\Route;

$asset = static function (string $name, string $type) {
    return static function (ReferenceConfig $config) use ($name, $type) {
        $path = $config->sharedAssetRoot.DIRECTORY_SEPARATOR.$name;
        abort_unless(is_file($path), 404);

        return response()->file($path, ['Content-Type' => $type, 'Cache-Control' => 'no-store']);
    };
};

Route::get('/', $asset('index.html', 'text/html; charset=utf-8'));
Route::get('/app.css', $asset('app.css', 'text/css; charset=utf-8'));
Route::get('/app.js', $asset('app.js', 'text/javascript; charset=utf-8'));
Route::get('/_content/Cormier.Realtime.Browser/{asset}', function (ReferenceConfig $config, string $asset) {
    abort_unless((bool) preg_match('/^[A-Za-z0-9._-]+$/D', $asset), 404);
    $path = $config->sdkAssetRoot.DIRECTORY_SEPARATOR.$asset;
    abort_unless(is_file($path), 404);

    return response()->file($path, ['Content-Type' => str_ends_with($asset, '.js') ? 'text/javascript; charset=utf-8' : 'application/json', 'Cache-Control' => 'no-store']);
});
Route::get('/health', [ReferenceController::class, 'health']);
Route::get('/api/diagnostics', [ReferenceController::class, 'diagnostics']);
Route::post('/api/login', [ReferenceController::class, 'login']);
Route::get('/api/session', [ReferenceController::class, 'session']);
Route::post('/api/logout', [ReferenceController::class, 'logout']);
Route::post('/realtime/tickets', [ReferenceController::class, 'ticket']);
