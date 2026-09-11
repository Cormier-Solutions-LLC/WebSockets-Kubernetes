from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("origin configuration is invalid")
    return value.rstrip("/")


def _identifiers(value: str, *, colon: bool = False) -> str:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    if colon:
        allowed.add(":")
    if not 1 <= len(value) <= 128 or any(character not in allowed for character in value):
        raise ValueError("identifier configuration is invalid")
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=True)

    PORT: int = Field(ge=1024, le=65535)
    PUBLIC_ORIGIN: str
    GATEWAY_URL: str
    REDIS_URL: str
    SESSION_LIFETIME_SECONDS: int = Field(ge=60, le=7200)
    INSTANCE_NAME: str
    TOPOLOGY: str
    REDIS_INSTANCE_PREFIX: str
    REDIS_SESSION_KEY_PREFIX: str
    ALLOWED_TENANTS: str
    ALLOWED_USERS: str
    SHARED_ASSET_ROOT: Path = Path("../shared-web/wwwroot")
    SDK_ASSET_ROOT: Path = Path("../../sdk/typescript/dist")

    @field_validator("PUBLIC_ORIGIN", "GATEWAY_URL")
    @classmethod
    def validate_origin(cls, value: str) -> str:
        return _origin(value)

    @field_validator("REDIS_URL")
    @classmethod
    def validate_redis(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"redis", "rediss"} or not parsed.hostname or parsed.fragment:
            raise ValueError("Redis configuration is invalid")
        return value

    @field_validator("INSTANCE_NAME", "REDIS_SESSION_KEY_PREFIX")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        return _identifiers(value)

    @field_validator("REDIS_INSTANCE_PREFIX")
    @classmethod
    def validate_prefix(cls, value: str) -> str:
        return _identifiers(value, colon=True)

    @field_validator("TOPOLOGY")
    @classmethod
    def validate_topology(cls, value: str) -> str:
        if value not in {"ha", "non-ha"}:
            raise ValueError("topology configuration is invalid")
        return value

    @property
    def tenants(self) -> frozenset[str]:
        return self._allowlist(self.ALLOWED_TENANTS)

    @property
    def users(self) -> frozenset[str]:
        return self._allowlist(self.ALLOWED_USERS)

    @staticmethod
    def _allowlist(value: str) -> frozenset[str]:
        items = frozenset(item.strip() for item in value.split(","))
        if not items:
            raise ValueError("allowlist configuration is invalid")
        for item in items:
            _identifiers(item)
        return items

    def session_key(self, session_id: str) -> str:
        return f"{self.REDIS_INSTANCE_PREFIX}:{self.REDIS_SESSION_KEY_PREFIX}:{session_id}"
