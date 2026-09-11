import httpx
import pytest

from reference_app import __main__ as entrypoint
from reference_app.config import Settings
from reference_app.main import (
    MAXIMUM_BODY_BYTES,
    browser_to_gateway,
    create_app,
    gateway_to_browser,
    offers_protocol,
    public_forwarding_headers,
)


class Upstream:
    def __init__(self) -> None:
        self.calls = 0
        self.arguments: list[tuple[tuple[object, ...], dict[str, object]]] = []

    async def post(self, *args: object, **kwargs: object) -> httpx.Response:
        self.calls += 1
        self.arguments.append((args, kwargs))
        return httpx.Response(202, content=b"{}", headers={"content-type": "application/json"})


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "LISTEN_HOST": "127.0.0.1",
        "PORT": 15500,
        "PUBLIC_ORIGIN": "http://127.0.0.1:15500",
        "GATEWAY_URL": "http://127.0.0.1:15501",
        "REDIS_URL": "redis://127.0.0.1:6379",
        "SESSION_LIFETIME_SECONDS": 1200,
        "INSTANCE_NAME": "python-fastapi-a",
        "TOPOLOGY": "non-ha",
        "REDIS_INSTANCE_PREFIX": "cormier:test",
        "REDIS_SESSION_KEY_PREFIX": "sessions",
        "ALLOWED_TENANTS": "tenant-a",
        "ALLOWED_USERS": "user-a",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def test_public_forwarding_headers_use_the_validated_browser_scheme() -> None:
    configured = settings(PUBLIC_ORIGIN="https://public.example.test", GATEWAY_URL="http://gateway.example.test")
    assert public_forwarding_headers(configured) == {"X-Forwarded-Proto": "https"}


def test_websocket_requires_the_exact_subprotocol() -> None:
    assert offers_protocol(None) is False
    assert offers_protocol("other, cormier.realtime.v10") is False
    assert offers_protocol("other, cormier.realtime.v1") is True


@pytest.mark.asyncio
async def test_browser_close_details_are_forwarded() -> None:
    class Browser:
        async def receive(self) -> dict[str, object]:
            return {"type": "websocket.disconnect", "code": 1001, "reason": "leaving"}

    class Gateway:
        closed: tuple[int, str] | None = None

        async def close(self, *, code: int, reason: str) -> None:
            self.closed = (code, reason)

    gateway = Gateway()
    await browser_to_gateway(Browser(), gateway)  # type: ignore[arg-type]
    assert gateway.closed == (1001, "leaving")


@pytest.mark.asyncio
async def test_normal_gateway_close_details_are_forwarded() -> None:
    class Gateway:
        close_code = 1000
        close_reason = "complete"

        def __aiter__(self):  # type: ignore[no-untyped-def]
            async def messages():  # type: ignore[no-untyped-def]
                if False:
                    yield ""

            return messages()

    class Browser:
        closed: tuple[int, str] | None = None

        async def close(self, *, code: int, reason: str) -> None:
            self.closed = (code, reason)

    browser = Browser()
    await gateway_to_browser(Gateway(), browser)  # type: ignore[arg-type]
    assert browser.closed == (1000, "complete")


def test_uvicorn_caps_browser_websocket_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    options: dict[str, object] = {}
    monkeypatch.setattr(entrypoint, "Settings", lambda: settings())
    monkeypatch.setattr(entrypoint.uvicorn, "run", lambda *_args, **kwargs: options.update(kwargs))

    assert entrypoint.main() == 0
    assert options["ws_max_size"] == MAXIMUM_BODY_BYTES


@pytest.mark.asyncio
async def test_ticket_forwards_the_public_scheme_to_an_internal_gateway() -> None:
    configured = settings(PUBLIC_ORIGIN="https://public.example.test", GATEWAY_URL="http://gateway.example.test")
    app = create_app(configured)
    upstream = Upstream()
    app.state.http = upstream
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://public.example.test") as client:
        response = await client.post("/realtime/tickets", headers={"Origin": configured.PUBLIC_ORIGIN}, content=b"{}")

    assert response.status_code == 202
    assert upstream.calls == 1
    assert upstream.arguments[0][1]["headers"]["X-Forwarded-Proto"] == "https"  # type: ignore[index]


@pytest.mark.asyncio
async def test_ticket_rejects_streamed_oversized_body_before_forwarding() -> None:
    app = create_app(settings())
    upstream = Upstream()
    app.state.http = upstream

    async def content():  # type: ignore[no-untyped-def]
        yield b"a" * MAXIMUM_BODY_BYTES
        yield b"b"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://reference.test") as client:
        response = await client.post(
            "/realtime/tickets",
            headers={"Origin": "http://127.0.0.1:15500"},
            content=content(),
        )

    assert response.status_code == 413
    assert upstream.calls == 0


@pytest.mark.asyncio
async def test_login_rejects_streamed_oversized_body_before_model_parsing() -> None:
    app = create_app(settings())

    async def content():  # type: ignore[no-untyped-def]
        yield b"a" * MAXIMUM_BODY_BYTES
        yield b"b"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://reference.test") as client:
        response = await client.post(
            "/api/login",
            headers={"Origin": "http://127.0.0.1:15500"},
            content=content(),
        )

    assert response.status_code == 413
    assert response.json()["code"] == "invalid_request"
