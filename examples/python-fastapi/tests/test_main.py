import httpx
import pytest

from reference_app.config import Settings
from reference_app.main import MAXIMUM_BODY_BYTES, create_app


class Upstream:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *args: object, **kwargs: object) -> httpx.Response:
        self.calls += 1
        return httpx.Response(202, content=b"{}", headers={"content-type": "application/json"})


def settings() -> Settings:
    return Settings.model_validate(
        {
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
    )


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
