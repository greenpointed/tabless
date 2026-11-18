import os
import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gmail_sync as gs


def raw_email(subject, sender, body, html=False):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["Date"] = subject, sender, "Mon, 16 Nov 2026 10:00:00 -0800"
    if html:
        msg.set_content("<p>" + body + "</p>", subtype="html")
    else:
        msg.set_content(body)
    return msg.as_bytes()


class FakeGmail:
    def __init__(self, mails):
        self.mails = [gs.message_to_dict(m) for m in mails]
        self.queries = []

    def search(self, queries, limit=25):
        self.queries += queries
        out = []
        for q in queries:
            term = q.split('"')[1].lower()
            out += [m for m in self.mails if term in f"{m['subject']} {m['body']} {m['from_']}".lower() and m not in out]
        return out


class FakeAPI:
    def __init__(self, jobs):
        self._jobs, self.updates, self.created = jobs, [], []

    def jobs(self):
        return self._jobs

    def update_job(self, job_id, payload):
        self.updates.append((job_id, payload))

    def create_job(self, payload):
        self.created.append(payload)

    def parse_job(self, url):
        return {"location": "Remote", "role": "Parsed Role"}


class ClassificationTests(unittest.TestCase):
    def test_statuses(self):
        cases = {
            "We have decided not to move forward with your application.": "Rejected",
            "We would like to extend an offer to join the team.": "Offer",
            "Acme: we'd like to schedule an interview with the team.": "Interview",
            "Thank you for applying to Acme.": "Applied",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(gs.classify_email("Acme update", text, text[:80], "Acme"), expected)

    def test_progression_rules(self):
        self.assertTrue(gs.is_progression("Applied", "Interview"))
        self.assertFalse(gs.is_progression("Interview", "Applied"))
        self.assertFalse(gs.is_progression("Rejected", "Interview"))

    def test_html_email_is_parsed(self):
        m = gs.message_to_dict(raw_email("Hi", "Acme <jobs@acme.com>", "Thank you for applying", html=True))
        self.assertIn("Thank you for applying", m["body"])
        self.assertTrue(m["date"].startswith("2026-11-16"))

    def test_quote_escapes(self):
        self.assertEqual(gs._quote('say "hi"'), '"say \\"hi\\""')


class FakeIMAP:
    def __init__(self, host):
        self.selected = None
        self.raw = raw_email("Thank you for applying to Acme", "Acme <jobs@acme.com>", "Thank you for applying")

    def login(self, user, pw):
        self.user = user

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"']

    def select(self, folder, readonly=False):
        self.selected, self.readonly = folder, readonly
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "SEARCH":
            self.search_args = args
            return "OK", [b"7"]
        assert args[1] == "(BODY.PEEK[])"
        return "OK", [(b"7 (BODY[] {100}", self.raw), b")"]

    def logout(self):
        pass


class GmailClientTests(unittest.TestCase):
    def test_read_only_all_mail_search(self):
        with mock.patch.object(gs.imaplib, "IMAP4_SSL", FakeIMAP):
            g = gs.Gmail("me@example.com", "app-password")
            self.assertEqual(g.imap.selected, '"[Gmail]/All Mail"')
            self.assertTrue(g.imap.readonly)
            mails = g.search(['"thank you for applying" newer_than:2d'])
            self.assertEqual(g.imap.search_args, ("X-GM-RAW", '"\\"thank you for applying\\" newer_than:2d"'))
            self.assertEqual(mails[0]["subject"], "Thank you for applying to Acme")


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"AUTOMATION_DATA_DIR": self.tmp.name})
        self.env.start()
        self.jobs = [
            {"id": 1, "company": "Acme", "role": "Senior PM", "status": "Applied", "appliedAt": "2026-11-01"},
            {"id": 2, "company": "Closed Co", "role": "PM", "status": "Rejected"},
        ]
        self.mails = [
            raw_email("Your application to Acme", "Acme Recruiting <talent@acme.com>",
                      "Hi Sam, unfortunately we will not be moving forward with your application at Acme."),
            raw_email("Thank you for applying to Nimbus", "Nimbus Talent <no-reply@nimbus.io>",
                      "Thank you for applying to Nimbus for the Product Manager, Growth position. "
                      "View the role: https://boards.greenhouse.io/nimbus/jobs/123"),
        ]

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_updates_and_discovers(self):
        api = FakeAPI(self.jobs)
        result = gs.run(api, FakeGmail(self.mails))
        self.assertEqual(api.updates, [(1, {"status": "Rejected"})])
        self.assertEqual(len(api.created), 1)
        new = api.created[0]
        self.assertEqual(new["company"], "Nimbus")
        self.assertEqual(new["role"], "Product Manager, Growth")
        self.assertEqual(new["status"], "Applied")
        self.assertEqual(new["appliedAt"], "2026-11-16")
        self.assertEqual(new["url"], "https://boards.greenhouse.io/nimbus/jobs/123")
        self.assertEqual(result["errors"], [])
        self.assertTrue(Path(self.tmp.name, "gmail_sync_decisions.jsonl").exists())

    def test_dry_run_writes_nothing(self):
        api = FakeAPI(self.jobs)
        result = gs.run(api, FakeGmail(self.mails), dry_run=True)
        self.assertEqual((api.updates, api.created), ([], []))
        self.assertEqual(len(result["updates"]) + len(result["added"]), 2)

    def test_missing_credentials_exit_cleanly(self):
        with mock.patch.dict(os.environ, {"GMAIL_ADDRESS": "", "GMAIL_APP_PASSWORD": "",
                                          "JOB_TRACKER_ENV_FILE": "/nonexistent"}):
            with mock.patch.object(gs, "setting", lambda k, d="": d):
                self.assertEqual(gs.main([]), 2)


if __name__ == "__main__":
    unittest.main()
