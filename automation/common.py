"""Shared helpers for the optional automation scripts.

Settings come from environment variables or the tracker's `.env` file
(repository root). Nothing here is tied to a particular person or account:
every installation supplies its own tracker URL, login and (optionally)
Gmail and notification settings.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> dict[str, str]:
    path = Path(os.environ.get("JOB_TRACKER_ENV_FILE", REPO_ROOT / ".env"))
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_DOTENV = _load_dotenv()


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name) or _DOTENV.get(name) or default


def data_dir() -> Path:
    """Where logs and reports are written (Git-ignored by default)."""
    path = Path(setting("AUTOMATION_DATA_DIR", str(REPO_ROOT / "automation-data")))
    path.mkdir(parents=True, exist_ok=True)
    return path


class TrackerAPI:
    """Minimal client for the tracker's own authenticated REST API."""

    def __init__(self, base_url: str | None = None, username: str | None = None,
                 password: str | None = None):
        self.base = (base_url or setting("TRACKER_URL", f"http://127.0.0.1:{setting('PORT', '5000')}")).rstrip("/")
        user = username or setting("APP_USERNAME")
        pw = password or setting("APP_PASSWORD")
        if not user or not pw:
            raise RuntimeError("Set APP_USERNAME and APP_PASSWORD (same values the tracker uses).")
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json",
                        "Accept": "application/json"}

    def _call(self, method: str, path: str, payload: dict | None = None, timeout: int = 30):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(f"{self.base}{path}", data=data, headers=self.headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"null")

    def jobs(self) -> list[dict]:
        return self._call("GET", "/api/jobs")

    def create_job(self, payload: dict) -> dict:
        return self._call("POST", "/api/jobs", payload)

    def update_job(self, job_id: int, payload: dict) -> dict:
        return self._call("PATCH", f"/api/jobs/{job_id}", payload)

    def parse_job(self, url: str) -> dict:
        return self._call("POST", "/api/parse-job", {"url": url}, timeout=60)


def notify(title: str, body: str) -> bool:
    """Post to an optional webhook (Slack, Discord, ntfy, etc.). Returns True if sent."""
    url = setting("NOTIFY_WEBHOOK_URL")
    if not url:
        return False
    text = f"{title}\n{body}"
    payload = json.dumps({"text": text, "content": text[:1900]}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=15).close()
        return True
    except Exception as exc:  # notifications must never break a run
        print(f"Notification failed: {exc}")
        return False
