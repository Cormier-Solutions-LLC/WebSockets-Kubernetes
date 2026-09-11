<?php

namespace App\Http\Controllers;

use App\ReferenceConfig;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Throwable;

final class ReferenceController
{
    private const string COOKIE = 'cormier_session';

    private const int MAXIMUM_BODY_BYTES = 65536;

    public function __construct(private readonly ReferenceConfig $config) {}

    public function health(): JsonResponse
    {
        try {
            Redis::connection()->ping();

            return response()->json(['status' => 'healthy']);
        } catch (Throwable) {
            return response()->json(['status' => 'unavailable'], 503);
        }
    }

    public function diagnostics(): JsonResponse
    {
        try {
            Redis::connection()->ping();
            $redis = 'ready';
        } catch (Throwable) {
            $redis = 'unavailable';
        }

        return response()->json([
            'stack' => 'PHP / Laravel',
            'topology' => $this->config->topology,
            'instance' => $this->config->instanceName,
            'redis' => $redis,
            'timestamp' => now('UTC')->toIso8601String(),
        ]);
    }

    public function login(Request $request): JsonResponse
    {
        if (($failure = $this->rejectOrigin($request)) !== null) {
            return $failure;
        }
        if ((int) $request->server('CONTENT_LENGTH', 0) > self::MAXIMUM_BODY_BYTES) {
            return $this->invalidIdentity();
        }
        $payload = $request->validate([
            'tenantId' => ['required', 'string', 'max:128'],
            'userId' => ['required', 'string', 'max:128'],
        ]);
        if (! $this->config->allows($payload['tenantId'], $payload['userId'])) {
            return $this->invalidIdentity();
        }
        $id = Str::random(48);
        $expiresAt = now('UTC')->addSeconds($this->config->sessionLifetimeSeconds);
        $record = [
            'tenantId' => $payload['tenantId'],
            'userId' => $payload['userId'],
            'allowedTopics' => ['orders', 'notifications'],
            'expiresAt' => $expiresAt->toIso8601String(),
            'revoked' => false,
        ];
        try {
            Redis::connection()->setex($this->config->sessionKey($id), $this->config->sessionLifetimeSeconds, json_encode($record, JSON_THROW_ON_ERROR));
        } catch (Throwable) {
            return $this->unavailable();
        }

        return response()->json($record)->cookie(
            self::COOKIE,
            $id,
            (int) ceil($this->config->sessionLifetimeSeconds / 60),
            '/',
            null,
            str_starts_with($this->config->publicOrigin, 'https://'),
            true,
            false,
            'Strict',
        );
    }

    public function session(Request $request): JsonResponse
    {
        try {
            $record = $this->readSession($request);
        } catch (Throwable) {
            return $this->unavailable();
        }
        if ($record === null) {
            return response()->json(['code' => 'authentication_required', 'message' => 'Authentication is required.'], 401);
        }

        return response()->json(['authenticated' => true] + $record);
    }

    public function logout(Request $request): Response|JsonResponse
    {
        if (($failure = $this->rejectOrigin($request)) !== null) {
            return $failure;
        }
        $id = (string) $request->cookie(self::COOKIE, '');
        if (preg_match('/^[A-Za-z0-9_-]{16,256}$/D', $id)) {
            try {
                Redis::connection()->del($this->config->sessionKey($id));
            } catch (Throwable) {
                return $this->unavailable();
            }
        }

        return response('', 204)->withoutCookie(self::COOKIE);
    }

    public function ticket(Request $request): Response|JsonResponse
    {
        if (($failure = $this->rejectOrigin($request)) !== null) {
            return $failure;
        }
        if (strlen($request->getContent()) > self::MAXIMUM_BODY_BYTES) {
            return response()->json(['code' => 'invalid_request', 'message' => 'The request is invalid.'], 413);
        }
        try {
            $upstream = Http::connectTimeout(5)->timeout(15)
                ->withHeaders(array_filter([
                    'Host' => $request->getHttpHost(),
                    'Origin' => $request->header('Origin'),
                    'Cookie' => $request->header('Cookie'),
                    'Content-Type' => $request->header('Content-Type'),
                ]))
                ->withBody($request->getContent(), $request->header('Content-Type', 'application/json'))
                ->post($this->config->gatewayUrl.'/realtime/tickets');
        } catch (ConnectionException) {
            return $this->unavailable();
        }

        return response($upstream->body(), $upstream->status())
            ->header('Content-Type', $upstream->header('Content-Type') ?: 'application/json')
            ->header('Cache-Control', 'no-store');
    }

    /** @return array<string, mixed>|null */
    private function readSession(Request $request): ?array
    {
        $id = (string) $request->cookie(self::COOKIE, '');
        if (! preg_match('/^[A-Za-z0-9_-]{16,256}$/D', $id)) {
            return null;
        }
        $encoded = Redis::connection()->get($this->config->sessionKey($id));
        if (! is_string($encoded)) {
            return null;
        }
        $record = json_decode($encoded, true, flags: JSON_THROW_ON_ERROR);
        if (! is_array($record) || ($record['revoked'] ?? true) !== false || ! isset($record['expiresAt']) || strtotime($record['expiresAt']) <= time()) {
            return null;
        }

        return $record;
    }

    private function rejectOrigin(Request $request): ?JsonResponse
    {
        return $request->header('Origin') === $this->config->publicOrigin
            ? null
            : response()->json(['code' => 'origin_rejected', 'message' => 'The request Origin is not allowed.'], 403);
    }

    private function invalidIdentity(): JsonResponse
    {
        return response()->json(['code' => 'invalid_identity', 'message' => 'Select a configured test tenant and user.'], 400);
    }

    private function unavailable(): JsonResponse
    {
        return response()->json(['code' => 'service_unavailable', 'message' => 'The reference application dependency is unavailable.'], 503);
    }
}
