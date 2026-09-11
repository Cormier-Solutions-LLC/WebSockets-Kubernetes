import json
import sys

import uvicorn

from .config import MAXIMUM_BODY_BYTES, Settings


def main() -> int:
    try:
        settings = Settings()  # type: ignore[call-arg]
    except Exception:
        sys.stderr.write(json.dumps({"event": "startup_failed", "stack": "python-fastapi"}) + "\n")
        return 1
    uvicorn.run(
        "reference_app.main:app",
        host=settings.LISTEN_HOST,
        port=settings.PORT,
        access_log=False,
        log_config=None,
        log_level="error",
        ws_max_size=MAXIMUM_BODY_BYTES,
        timeout_graceful_shutdown=15,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
