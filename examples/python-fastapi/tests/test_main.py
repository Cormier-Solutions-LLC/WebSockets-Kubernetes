import httpx
import pytest

from reference_app.config import Settings
from reference_app.main import MAXIMUM_BODY_BYTES, create_app, public_forwarding_headers


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
