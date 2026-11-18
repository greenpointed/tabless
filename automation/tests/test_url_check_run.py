import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import url_check


class FakeSite(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/open":
            self.send_response(200); self.end_headers()
            self.wfile.write(b"<h1>Senior PM</h1><p>Apply for this job.</p>")
        elif self.path == "/filled":
            self.send_response(200); self.end_headers()
            self.wfile.write(b"<p>This position has been filled.</p>")
        elif self.path == "/blocked":
            self.send_response(403); self.end_headers()
        else:
            self.send_response(404); self.end_headers()

    def log_message(self, *args):
        pass


class FakeAPI:
    def __init__(self, base):
        self.base = base

    def jobs(self):
        b = self.base
        return [
            {"id": 1, "company": "Acme", "role": "PM", "status": "Applied", "url": f"{b}/open"},
            {"id": 2, "company": "Beta", "role": "PM", "status": "Interested", "url": f"{b}/filled"},
            {"id": 3, "company": "Gamma", "role": "PM", "status": "Applied", "url": f"{b}/gone"},
            {"id": 4, "company": "Delta", "role": "PM", "status": "Applied", "url": f"{b}/blocked"},
            {"id": 5, "company": "Done", "role": "PM", "status": "Rejected", "url": f"{b}/gone"},
            {"id": 6, "company": "NoUrl", "role": "PM", "status": "Applied", "url": ""},
        ]


class RunTests(unittest.TestCase):
    def test_run_writes_report_and_tracks_changes(self):
        server = HTTPServer(("127.0.0.1", 0), FakeSite)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"AUTOMATION_DATA_DIR": tmp, "NOTIFY_WEBHOOK_URL": ""}), \
                mock.patch.object(url_check, "TrackerAPI", lambda: FakeAPI(base)):
            self.assertEqual(url_check.main(["--no-delay"]), 0)
            state = json.loads(Path(tmp, "url_check_state.json").read_text())
            self.assertEqual(state["issue_job_ids"], [2, 3])
            self.assertEqual(state["checked"], 4)  # terminal status and empty URL skipped
            report = next(Path(tmp).glob("job-url-check-*.md")).read_text()
            self.assertIn("2 unavailable, 1 inconclusive, 1 with no issue", report)
            self.assertIn("2 newly flagged", report)
            # second run: nothing new
            url_check.main(["--no-delay"])
            report = next(Path(tmp).glob("job-url-check-*.md")).read_text()
            self.assertIn("0 newly flagged, 0 resolved", report)
            self.assertEqual(len(Path(tmp, "url_check_log.jsonl").read_text().splitlines()), 8)
        server.shutdown()


if __name__ == "__main__":
    unittest.main()
