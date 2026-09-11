import json
import sys

import uvicorn

from .config import MAXIMUM_BODY_BYTES, Settings


class ReadinessServer(uvicorn.Server):
    async def startup(self, sockets: list[object] | None = None) -> None:
        await super().startup(sockets=sockets)  # type: ignore[arg-type]
        if self.started:
            sys.stdout.write(json.dumps({"event": "application_started", "stack": "python-fastapi"}) + "\n")
            sys.stdout.flush()


def main() -> int:
    try:
        settings = Settings()  # type: ignore[call-arg]
    except Exception:
        sys.stderr.write(json.dumps({"event": "startup_failed", "stack": "python-fastapi"}) + "\n")
        return 1
    config = uvicorn.Config(
        "reference_app.main:app",
        host=settings.LISTEN_HOST,
        port=settings.PORT,
        access_log=False,
        log_config=None,
        log_level="error",
        ws_max_size=MAXIMUM_BODY_BYTES,
        timeout_graceful_shutdown=15,
    )
    server = ReadinessServer(config)
    try:
        server.run()
    except SystemExit:
        sys.stderr.write(json.dumps({"event": "startup_failed", "stack": "python-fastapi"}) + "\n")
        return 1
    if not server.started:
        sys.stderr.write(json.dumps({"event": "startup_failed", "stack": "python-fastapi"}) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
