import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from reference_app.config import Settings, gateway_port


def values() -> dict[str, object]:
    return {
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


def test_typed_configuration() -> None:
    settings = Settings.model_validate(values())
    assert settings.PORT == 15500
    assert settings.LISTEN_HOST == "127.0.0.1"
    assert settings.tenants == frozenset({"tenant-a"})
    assert settings.session_key("id") == "cormier:test:sessions:id"


def test_unsafe_origin_is_rejected() -> None:
    environment = values()
    environment["PUBLIC_ORIGIN"] = "file:///tmp"
    with pytest.raises(ValidationError):
        Settings.model_validate(environment)
    environment["PUBLIC_ORIGIN"] = "https://example.test:443"
    with pytest.raises(ValidationError):
        Settings.model_validate(environment)


def test_gateway_default_ports() -> None:
    assert gateway_port("http://gateway.example") == 80
    assert gateway_port("https://gateway.example") == 443
    assert gateway_port("https://gateway.example:8443") == 8443


def test_canonical_contracts() -> None:
    root = Path(__file__).parents[3]
    schema = json.loads((root / "examples/shared-web/reference-app.schema.json").read_text())
    sdk = json.loads((root / "sdk/typescript/dist/version.json").read_text())
    protocol = json.loads((root / "protocol/fixtures/v1/envelopes.json").read_text())
    assert {"PORT", "PUBLIC_ORIGIN", "GATEWAY_URL", "REDIS_URL"} <= set(schema["required"])
    assert sdk["protocolVersion"] == "1.0"
    assert protocol["protocolVersion"] == "1.0"
