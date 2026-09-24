import os

for name, value in {
    "LISTEN_HOST": "127.0.0.1",
    "PORT": "15500",
    "PUBLIC_ORIGIN": "http://127.0.0.1:15500",
    "GATEWAY_URL": "http://127.0.0.1:15501",
    "REDIS_URL": "redis://127.0.0.1:6379",
    "SESSION_LIFETIME_SECONDS": "1200",
    "HEARTBEAT_INTERVAL_MILLISECONDS": "5000",
    "INSTANCE_NAME": "python-fastapi-a",
    "TOPOLOGY": "non-ha",
    "REDIS_INSTANCE_PREFIX": "cormier:test",
    "REDIS_SESSION_KEY_PREFIX": "sessions",
    "ALLOWED_TENANTS": "tenant-a",
    "ALLOWED_USERS": "user-a",
}.items():
    os.environ.setdefault(name, value)
