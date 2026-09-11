import asyncio
import json
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import redis.asyncio as redis
import websockets
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict

from .config import Settings, gateway_port

logging.basicConfig(level=logging.INFO, format='{"event":"%(message)s","stack":"python-fastapi"}')
logger = logging.getLogger("reference")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("uvicorn").setLevel(logging.CRITICAL)
logging.getLogger("websockets").setLevel(logging.CRITICAL)
MAXIMUM_BODY_BYTES = 64 * 1024
SESSION_COOKIE = "cormier_session"
PROTOCOL = "cormier.realtime.v1"


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenantId: str
    userId: str


def safe_headers(response: Response) -> None:
    response.headers.update(
        {
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'",  # noqa: E501
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
        }
    )


def public_forwarding_headers(settings: Settings) -> dict[str, str]:
    return {"X-Forwarded-Proto": urlsplit(settings.PUBLIC_ORIGIN).scheme}


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or Settings()  # type: ignore[call-arg]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = redis.from_url(
            configured.REDIS_URL,
            socket_connect_timeout=5,
            socket_timeout=5,
            health_check_interval=30,
            decode_responses=True,
        )
        http = httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), limits=httpx.Limits(max_connections=100))
        try:
            await asyncio.wait_for(client.ping(), timeout=5)
            for path in (
                configured.SHARED_ASSET_ROOT / "index.html",
                configured.SHARED_ASSET_ROOT / "app.css",
                configured.SHARED_ASSET_ROOT / "app.js",
                configured.SDK_ASSET_ROOT / "cormier-realtime.iife.min.js",
            ):
                if not path.is_file():
                    raise RuntimeError("required asset is unavailable")
        except Exception:
            logger.error("startup_failed")
            await client.aclose()
            await http.aclose()
            raise
        app.state.redis = client
        app.state.http = http
        logger.info("application_started")
        try:
            yield
        finally:
            await http.aclose()
            await client.aclose()
            logger.info("application_stopped")

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(HTTPException)
    async def http_exception(_request: Request, exception: HTTPException) -> JSONResponse:
        if isinstance(exception.detail, dict):
            return JSONResponse(exception.detail, exception.status_code, headers=exception.headers)
        return JSONResponse(
            {"code": "request_failed", "message": "The request could not be completed."}, exception.status_code
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        try:
            response = await call_next(request)
        except Exception:
            logger.error("request_failed")
            response = JSONResponse({"code": "internal_error", "message": "The request could not be completed."}, 500)
        safe_headers(response)
        return response

    def asset(root: Path, name: str, media_type: str) -> FileResponse:
        path = root / name
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})

    @app.get("/")
    async def index() -> FileResponse:
        return asset(configured.SHARED_ASSET_ROOT, "index.html", "text/html")

    @app.get("/app.css")
    async def css() -> FileResponse:
        return asset(configured.SHARED_ASSET_ROOT, "app.css", "text/css")

    @app.get("/app.js")
    async def javascript() -> FileResponse:
        return asset(configured.SHARED_ASSET_ROOT, "app.js", "text/javascript")

    @app.get("/_content/Cormier.Realtime.Browser/{name}")
    async def sdk_asset(name: str) -> FileResponse:
        if not name or any(
            character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in name
        ):
            raise HTTPException(404)
        return asset(configured.SDK_ASSET_ROOT, name, "text/javascript" if name.endswith(".js") else "application/json")

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        try:
            await asyncio.wait_for(request.app.state.redis.ping(), timeout=5)
            return JSONResponse({"status": "healthy"})
        except Exception:
            return JSONResponse({"status": "unavailable"}, 503)

    @app.get("/api/diagnostics")
    async def diagnostics(request: Request) -> dict[str, str]:
        try:
            await asyncio.wait_for(request.app.state.redis.ping(), timeout=5)
            redis_status = "ready"
        except Exception:
            redis_status = "unavailable"
        return {
            "stack": "Python / FastAPI",
            "topology": configured.TOPOLOGY,
            "instance": configured.INSTANCE_NAME,
            "redis": redis_status,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    def require_origin(origin: str | None) -> None:
        if origin != configured.PUBLIC_ORIGIN:
            raise HTTPException(
                403, detail={"code": "origin_rejected", "message": "The request Origin is not allowed."}
            )

    @app.post("/api/login")
    async def login(body: LoginRequest, request: Request, response: Response) -> dict[str, object]:
        require_origin(request.headers.get("origin"))
        if body.tenantId not in configured.tenants or body.userId not in configured.users:
            raise HTTPException(
                400, detail={"code": "invalid_identity", "message": "Select a configured test tenant and user."}
            )
        session_id = secrets.token_urlsafe(36)
        expires_at = datetime.now(UTC) + timedelta(seconds=configured.SESSION_LIFETIME_SECONDS)
        record = {
            "tenantId": body.tenantId,
            "userId": body.userId,
            "allowedTopics": ["orders", "notifications"],
            "expiresAt": expires_at.isoformat(),
            "revoked": False,
        }
        try:
            await request.app.state.redis.setex(
                configured.session_key(session_id),
                configured.SESSION_LIFETIME_SECONDS,
                json.dumps(record, separators=(",", ":")),
            )
        except Exception:
            raise HTTPException(
                503,
                detail={
                    "code": "service_unavailable",
                    "message": "The reference application dependency is unavailable.",
                },
            ) from None
        response.set_cookie(
            SESSION_COOKIE,
            session_id,
            max_age=configured.SESSION_LIFETIME_SECONDS,
            secure=configured.PUBLIC_ORIGIN.startswith("https://"),
            httponly=True,
            samesite="strict",
        )
        return record

    @app.get("/api/session")
    async def session(request: Request) -> JSONResponse:
        record = await read_session(request, configured)
        if record is None:
            return JSONResponse({"code": "authentication_required", "message": "Authentication is required."}, 401)
        return JSONResponse({"authenticated": True, **record})

    @app.post("/api/logout", status_code=204)
    async def logout(request: Request) -> Response:
        require_origin(request.headers.get("origin"))
        session_id = request.cookies.get(SESSION_COOKIE, "")
        if valid_session_id(session_id):
            try:
                await request.app.state.redis.delete(configured.session_key(session_id))
            except Exception:
                raise HTTPException(
                    503,
                    detail={
                        "code": "service_unavailable",
                        "message": "The reference application dependency is unavailable.",
                    },
                ) from None
        response = Response(status_code=204)
        response.delete_cookie(SESSION_COOKIE)
        return response

    @app.post("/realtime/tickets")
    async def ticket(request: Request) -> Response:
        require_origin(request.headers.get("origin"))
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAXIMUM_BODY_BYTES:
                return JSONResponse({"code": "invalid_request", "message": "The request is invalid."}, 413)
            body.extend(chunk)
        headers = {
            name: request.headers[name]
            for name in ("host", "origin", "cookie", "content-type")
            if name in request.headers
        }
        headers.update(public_forwarding_headers(configured))
        try:
            upstream = await request.app.state.http.post(
                f"{configured.GATEWAY_URL}/realtime/tickets", content=bytes(body), headers=headers
            )
        except httpx.HTTPError:
            return JSONResponse(
                {"code": "service_unavailable", "message": "The reference application dependency is unavailable."}, 503
            )
        return Response(
            upstream.content, upstream.status_code, media_type=upstream.headers.get("content-type", "application/json")
        )

    @app.websocket("/realtime/ws")
    async def websocket_proxy(browser: WebSocket) -> None:
        if browser.headers.get("origin") != configured.PUBLIC_ORIGIN:
            await browser.close(code=1008, reason="origin rejected")
            return
        gateway = urlsplit(configured.GATEWAY_URL)
        browser_authority = browser.headers.get("host", "")
        uri = urlunsplit(
            ("wss" if gateway.scheme == "https" else "ws", browser_authority, "/realtime/ws", browser.url.query, "")
        )
        headers = {"Cookie": browser.headers.get("cookie", ""), **public_forwarding_headers(configured)}
        try:
            async with websockets.connect(
                uri,
                host=gateway.hostname,
                port=gateway_port(configured.GATEWAY_URL),
                server_hostname=gateway.hostname if gateway.scheme == "https" else None,
                origin=browser.headers.get("origin"),
                additional_headers=headers,
                subprotocols=[PROTOCOL],
                open_timeout=10,
                close_timeout=5,
                max_size=MAXIMUM_BODY_BYTES,
            ) as upstream:
                await browser.accept(subprotocol=PROTOCOL)
                tasks = {
                    asyncio.create_task(browser_to_gateway(browser, upstream)),
                    asyncio.create_task(gateway_to_browser(upstream, browser)),
                }
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    with suppress(Exception):
                        await task
                for task in pending:
                    task.cancel()
                for task in pending:
                    with suppress(asyncio.CancelledError):
                        await task
        except Exception:
            with suppress(RuntimeError):
                await browser.close(code=1013, reason="dependency unavailable")

    return app


def valid_session_id(value: str) -> bool:
    return 16 <= len(value) <= 256 and all(character.isalnum() or character in "-_" for character in value)


async def read_session(request: Request, settings: Settings) -> dict[str, object] | None:
    session_id = request.cookies.get(SESSION_COOKIE, "")
    if not valid_session_id(session_id):
        return None
    try:
        encoded = await request.app.state.redis.get(settings.session_key(session_id))
        record = json.loads(encoded) if encoded else None
    except Exception:
        raise HTTPException(
            503,
            detail={"code": "service_unavailable", "message": "The reference application dependency is unavailable."},
        ) from None
    if not isinstance(record, dict) or record.get("revoked", True) is not False:
        return None
    try:
        if datetime.fromisoformat(str(record["expiresAt"])) <= datetime.now(UTC):
            return None
    except KeyError, ValueError:
        return None
    return record


async def browser_to_gateway(browser: WebSocket, gateway) -> None:  # type: ignore[no-untyped-def]
    try:
        while True:
            message = await browser.receive()
            if message.get("type") == "websocket.disconnect":
                return
            data = message.get("bytes") if message.get("bytes") is not None else message.get("text")
            if data is not None:
                await gateway.send(data)
    except WebSocketDisconnect:
        return


async def gateway_to_browser(gateway, browser: WebSocket) -> None:  # type: ignore[no-untyped-def]
    async for message in gateway:
        if isinstance(message, bytes):
            await browser.send_bytes(message)
        else:
            await browser.send_text(message)


app = create_app()
