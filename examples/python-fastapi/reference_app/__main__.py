import json
import sys

import uvicorn

from .config import Settings


def main() -> int:
    try:
        settings = Settings()  # type: ignore[call-arg]
    except Exception:
        sys.stderr.write(json.dumps({"event": "startup_failed", "stack": "python-fastapi"}) + "\n")
        return 1
    uvicorn.run(
        "reference_app.main:app",
        host="0.0.0.0",  # noqa: S104 - container listener; publishing is deployment-controlled.
        port=settings.PORT,
        access_log=False,
        log_config=None,
        log_level="error",
        timeout_graceful_shutdown=15,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
