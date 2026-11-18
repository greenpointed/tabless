#!/usr/bin/env python3
"""Gmail -> TabLess sync (optional).

Connects to YOUR Gmail account over IMAP (read-only) and:

1. STATUS UPDATES  - for jobs already in the tracker, looks for recent emails
   (application confirmation, phone screen, interview, offer, rejection) and
   moves the job forward when a clear progression is found.
2. NEW APPLICATIONS - finds recent "thank you for applying" emails for
   companies not yet tracked and adds them with status "Applied". If the email
   contains an ATS/careers link, the tracker parses it for role details.

Setup: turn on 2-Step Verification for your Google account, create an app
password (https://myaccount.google.com/apppasswords), then set GMAIL_ADDRESS
and GMAIL_APP_PASSWORD in `.env`. The mailbox is opened read-only and messages
are not marked as read. Every decision is logged to gmail_sync_decisions.jsonl
in the automation data folder.

Usage:  python3 automation/gmail_sync.py [--dry-run] [--days N]
"""

from __future__ import annotations

import argparse
import email
import email.header
import email.utils
import imaplib
import json
import re
import sys
import time
from datetime import datetime, timezone
from html.parser import HTMLParser

from common import TrackerAPI, data_dir, notify, setting

# Status progression order (higher index = further along)
STATUS_ORDER = [
    "Interested",
    "Applied",
    "Phone Screen",
    "Interview",
    "Offer",
    "Rejected",
    "Withdrawn",
]

# Terminal statuses — never auto-change away from these
TERMINAL = {"Offer", "Rejected", "Withdrawn"}

# ── Email classification signals ─────────────────────────────────────────────
# Each entry: (status, [patterns], min_matches_required)
# min_matches_required: how many patterns must match to fire that status.
# Higher = more conservative. Use 2+ for ambiguous statuses.
SIGNALS = [
    ("Offer", [
        r"offer letter",
        r"we('d| would) like to extend (a|an) (formal )?offer",
        r"pleased to (extend|offer)",
        r"formal offer",
        r"congratulations.{0,30}(offer|join)",
        r"we are (pleased|delighted|excited) to offer you",
    ], 1),  # offer language is unambiguous — 1 strong match is fine
    ("Rejected", [
        # High-confidence rejection phrases only — removed "unfortunately",
        # "other candidates", "not a fit" as standalone triggers (too broad)
        r"we('ve| have) decided (not to move forward|to move forward with (other candidates|candidates whose))",
        r"will not be moving forward with your (application|candidacy)",
        r"not moving forward with your (application|candidacy|profile)",
        r"decided to pursue other candidates",
        r"we won'?t be moving forward",
        r"regret to inform you.{0,60}(not|won'?t|will not)",
        r"have chosen (not to move forward|to move forward with other)",
        r"your (application|candidacy) (has|was) not selected",
        r"we('ve| have) (chosen|selected) (another|a different) candidate",
        # Polite rejections: "decided to move forward with candidates whose experience..."
        r"decided to move forward with (other candidates|candidates whose)",
        r"move forward with (other|another) (candidate|candidates)(?! application)",
        r"(decided|chosen) to (move forward|proceed) with (a different|another|other) (candidate|direction|applicant)",
        # Direction change rejections
        r"(going|gone|decided to go|choosing to go) in a different direction",
        r"(decided|chosen) to (go|move) in a different direction",
    ], 1),  # each of these is already highly specific
    ("Interview", [
        # Must be explicitly about scheduling/inviting — not just the word "interview"
        r"(schedule|set up|book|arrange).{0,40}(interview|meeting|time)",
        r"(invite|inviting) you.{0,40}(interview|meet|next (round|step|stage))",
        r"we('d| would) like to (schedule|invite you to) (an )?(interview|meet)",
        r"(next round|next step|next stage).{0,60}(interview|meet|team)",
        r"(technical|virtual|on[-\s]?site|panel) (interview|assessment|round)",
        r"move (you |forward )?(to |into )?(the )?(next|interview|final) (round|stage|step)",
    ], 1),
    ("Phone Screen", [
        # Must reference scheduling a specific call — not just chatting
        r"(schedule|set up|book|arrange).{0,40}(phone|call|screen|chat)",
        r"phone (screen|call|interview) with",
        r"introductory (call|conversation) with",
        r"(30|15|45)[ -]minute (phone |video )?(call|screen|chat)",
        r"recruiter (call|screen|chat)",
        r"(invite|inviting) you.{0,40}(call|chat|speak|connect)",
        r"next steps",   # e.g. subject "Next Steps at Acme!"
    ], 1),
    ("Applied", [
        r"thank you for (applying|your application|submitting)",
        r"application (received|submitted|confirmed)",
        r"we('ve| have) received your application",
        r"your application (has been|was) (received|submitted)",
        r"application for .{0,60} has been received",
        r"you('ve| have) successfully applied",
    ], 1),
]

# Senders/subjects that should never be treated as job emails. Add your own
# with GMAIL_IGNORE_SENDERS / GMAIL_IGNORE_SUBJECTS (comma-separated regexes).
CONFIRMATION_BLOCKLIST_SENDERS = [p for p in setting("GMAIL_IGNORE_SENDERS").split(",") if p.strip()]
CONFIRMATION_BLOCKLIST_SUBJECTS = [p for p in setting("GMAIL_IGNORE_SUBJECTS").split(",") if p.strip()] + [
    r"\[INFO only\]",
]

# Patterns used specifically for new-job discovery emails
APPLICATION_CONFIRMATION_PATTERNS = [
    r"thank you for (applying|your application|submitting)",
    r"application (received|submitted|confirmed)",
    r"we('ve| have) received your application",
    r"your application (has been|was) (received|submitted)",
    r"you('ve| have) successfully applied",
    r"application for .{0,80} has been received",
]


# ── Classification ───────────────────────────────────────────────────────────

def classify_email(subject: str, body: str, snippet: str, company: str) -> str | None:
    """
    Return the status this email implies, or None if unclear.

    Requirements for a match:
    1. The company name must appear in the subject OR sender (checked before calling this).
    2. At least `min_matches` signal patterns must match.
    3. For Interview/Phone Screen, at least one match must be within 200 chars of
       the company name in the text (proximity check).
    """
    # Use subject + snippet + first 2000 chars of body
    text = f"{subject} {snippet} {body[:2000]}".lower()
    company_lower = company.lower()

    for status, patterns, min_matches in SIGNALS:
        matches = [pat for pat in patterns if re.search(pat, text, re.IGNORECASE)]
        if len(matches) < min_matches:
            continue

        # For scheduling-type statuses, require proximity to company name
        if status in ("Interview", "Phone Screen"):
            # Find positions of the company name in text
            company_positions = [m.start() for m in re.finditer(re.escape(company_lower), text)]
            if not company_positions:
                # Company not found in body — skip (subject check is done upstream)
                # Allow if company is in subject (text starts with subject)
                subject_lower = subject.lower()
                if company_lower not in subject_lower:
                    continue
            # Check if any signal pattern match is within 300 chars of the company name
            proximity_ok = False
            for pat in matches:
                m = re.search(pat, text, re.IGNORECASE)
                if m:
                    for cpos in company_positions:
                        if abs(m.start() - cpos) <= 300:
                            proximity_ok = True
                            break
                    if proximity_ok:
                        break
            # Also allow if company is in subject line directly
            if not proximity_ok and company_lower in subject.lower():
                proximity_ok = True
            if not proximity_ok:
                continue

        return status
    return None


def is_progression(current: str, new_status: str) -> bool:
    """True only if new_status is a valid forward move from current."""
    if current in TERMINAL:
        return False
    if new_status in ("Rejected", "Withdrawn"):
        return True  # can always be rejected/withdrawn
    try:
        return STATUS_ORDER.index(new_status) > STATUS_ORDER.index(current)
    except ValueError:
        return False


def extract_role_from_email(subject: str, body: str) -> str:
    """Try to extract a job title from a confirmation email."""
    # Strip leading greeting from body so it doesn't pollute matches
    body_clean = re.sub(r'^(?:Hi|Hello|Dear|Hey)\s+\w+[,!.\n]+\s*', '', body.strip(), flags=re.IGNORECASE)
    text = f"{subject}\n{body_clean[:600]}"

    for pat in [
        # "applying to Acme for the Product Manager, Growth position"
        r"apply(?:ing)? to [^.\n]{1,60}? for (?:the |our )?(.+?) (?:position|role|opportunity)",
        # "apply to our Senior Product Manager, Core Client Experience position"
        r"apply(?:ing)? to (?:our |the )?(.+?) (?:position|role|opportunity)",
        # "applying for the [Role] at [Company]"
        r"applying for (?:the )?(.+?) (?:at |position|role|opportunity)",
        # "Your application for [Role]"
        r"application (?:for (?:the )?|received[:\s]+)(.+?)(?:\s+at\s|\s*[-|\n]|$)",
        r"applied (?:to |for (?:the )?)(.+?) (?:at |position|role)",
        r"position[:\s]+(.+?)(?:\s+at\s|\s*[-|\n]|$)",
        r"role[:\s]+(.+?)(?:\s+at\s|\s*[-|\n]|$)",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            candidate = m.group(1).strip().rstrip(".,: ")
            if 2 < len(candidate) < 100:
                return candidate
    return ""


def extract_company_from_email(subject: str, body: str, sender: str) -> str:
    """Try to extract the company name from a confirmation email."""
    # Strip leading greeting lines from body ("Hi Alex," / "Dear Alex,")
    body_clean = re.sub(r'^(?:Hi|Hello|Dear|Hey)\s+\w+[,!.\n]+\s*', '', body.strip(), flags=re.IGNORECASE)
    # Prioritise subject (cleaner signal) then first 400 chars of cleaned body
    text = f"{subject}\n{body_clean[:400]}"

    # Subject/body patterns — use word boundaries and stop before greetings/newlines
    for pat in [
        r"applying to ([A-Z][\w\s&'.,-]{1,50}?)(?:\s+for|\s+position|\s+role|[.,!\n]|$)",
        r"application (?:to|at) ([A-Z][\w\s&'.,-]{1,50}?)(?:\s+for|\s+position|\s+role|[.,!\n]|$)",
        r"thank you for (?:applying|your application)[^.\n]{0,30}?(?:to|at) ([A-Z][\w\s&'.,-]{1,50}?)(?:\s+for|\s+position|[.,!\n]|$)",
        r"(?:The |Our )?[Tt]eam at ([A-Z][\w\s&'.,-]{1,50}?)(?:\s+as|\s+for|[.,!\n]|$)",
        r"joining ([A-Z][\w\s&'.,-]{1,50}?)(?:\s+as|\s+for|[.,!\n]|$)",
        r"interest in (?:joining )?([A-Z][\w\s&'.,-]{1,50}?)(?:\s+as|\s+for|[.,!\n]|$)",
    ]:
        m = re.search(pat, text)
        if m:
            candidate = m.group(1).strip().rstrip(".,! ")
            # Reject: too short/long, or looks like a generic word/greeting
            skip_words = r"^(the|our|a|an|this|your|senior|junior|staff|principal|lead|"\
                         r"manager|engineer|product|data|software|hi|hello|dear|team)$"
            words = candidate.split()
            if 1 <= len(words) <= 5 and 2 < len(candidate) < 60 and \
               not re.match(skip_words, words[0], re.IGNORECASE):
                return candidate

    # Fallback: extract from sender display name, e.g. "Acme Talent <no-reply@...>"
    display_match = re.match(r'^"?([^"<]+?)(?:\s+Talent|\s+Recruiting|\s+Team|\s+HR|\s+Careers)?\s*[<(]', sender)
    if display_match:
        candidate = display_match.group(1).strip()
        generic_senders = {"no-reply", "noreply", "do-not-reply", "jobs", "careers",
                           "notifications", "indeed", "linkedin", "greenhouse", "lever"}
        if candidate.lower() not in generic_senders and 2 < len(candidate) < 60:
            return candidate

    # Last resort: infer from sender domain
    sender_match = re.search(r"@(?:[\w-]+\.)?(\w+)\.(com|io|org|co)", sender)
    if sender_match:
        domain_name = sender_match.group(1)
        generic_ats = {"greenhouse", "lever", "workday", "icims", "myworkday",
                       "smartrecruiters", "indeed", "linkedin", "jobvite",
                       "taleo", "successfactors", "bamboohr", "greenhouse-mail",
                       "us", "mail", "jobs", "careers", "noreply", "no-reply"}
        if domain_name.lower() not in generic_ats:
            return domain_name.capitalize()

    return ""


def is_application_confirmation(subject: str, body: str, snippet: str, sender: str = "") -> bool:
    """Return True if this email looks like an application confirmation."""
    # First check blocklist — these are never job applications
    if any(re.search(pat, sender, re.IGNORECASE) for pat in CONFIRMATION_BLOCKLIST_SENDERS):
        return False
    if any(re.search(pat, subject, re.IGNORECASE) for pat in CONFIRMATION_BLOCKLIST_SUBJECTS):
        return False
    text = f"{subject} {snippet} {body[:800]}".lower()
    return any(re.search(pat, text, re.IGNORECASE) for pat in APPLICATION_CONFIRMATION_PATTERNS)


def already_tracked(company: str, jobs: list[dict]) -> dict | None:
    """Return the existing job record if this company is already tracked."""
    company_lower = company.lower().strip()
    for job in jobs:
        if job["company"].lower().strip() == company_lower:
            return job
    return None


def parse_email_date(date_str: str) -> str:
    """Parse ISO date string from email and return YYYY-MM-DD."""
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except Exception:
        return datetime.now(timezone.utc).date().isoformat()


def extract_url_from_email_body(body: str) -> str:
    """
    Try to find a direct job posting URL in the email body.
    Looks for ATS/careers URLs (greenhouse, lever, workday, icims, company careers pages).
    """
    ATS_PATTERNS = [
        r'https?://[\w.-]*(?:greenhouse\.io|lever\.co|myworkdayjobs\.com|icims\.com|'
        r'smartrecruiters\.com|jobvite\.com|taleo\.net|bamboohr\.com)[\w./?=&#%-]*',
        r'https?://(?:jobs|careers)\.\w+\.(?:com|io|org)[\w./?=&#%-]*',
        r'https?://\w+\.(?:com|io|org)/(?:jobs|careers)/[\w./?=&#%-]+',
    ]
    for pat in ATS_PATTERNS:
        m = re.search(pat, body)
        if m:
            return m.group(0).rstrip(')')
    return ""



# ── Gmail (IMAP) ─────────────────────────────────────────────────────────────

class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "a":
            href = dict(attrs).get("href")
            if href and href.startswith("http"):
                self.parts.append(f" {href} ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def _decode(value: str | None) -> str:
    if not value:
        return ""
    return str(email.header.make_header(email.header.decode_header(value)))


def message_to_dict(raw: bytes) -> dict:
    """Convert a raw RFC 822 message into the fields the classifier uses."""
    msg = email.message_from_bytes(raw)
    plain, html = [], []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart" or part.get_filename():
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True) or b""
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        (plain if ctype == "text/plain" else html).append(text)
    if plain:
        body = "\n".join(plain)
    else:
        parser = _Text()
        parser.feed("\n".join(html))
        body = " ".join("".join(parser.parts).split())
    try:
        date = email.utils.parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
    except Exception:
        date = ""
    body = body.strip()
    return {"subject": _decode(msg.get("Subject")), "from_": _decode(msg.get("From")),
            "date": date, "body": body, "snippet": " ".join(body.split())[:200]}


def _quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Gmail:
    """Read-only Gmail search using Gmail's own search syntax (X-GM-RAW)."""

    def __init__(self, address: str, app_password: str, host: str = "imap.gmail.com"):
        self.imap = imaplib.IMAP4_SSL(host)
        self.imap.login(address, app_password)
        self.imap.select(self._all_mail_folder(), readonly=True)
        self._cache: dict[bytes, dict] = {}

    def _all_mail_folder(self) -> str:
        status, folders = self.imap.list()
        for line in folders or []:
            line = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
            if "\\All" in line:
                return line.rsplit(' "/" ', 1)[-1]
        return "INBOX"

    def search(self, queries: list[str], limit: int = 25) -> list[dict]:
        uids: list[bytes] = []
        for q in queries:
            status, data = self.imap.uid("SEARCH", "X-GM-RAW", _quote(q))
            if status == "OK" and data and data[0]:
                uids += [u for u in data[0].split()[-limit:] if u not in uids]
        results = []
        for uid in uids:
            if uid not in self._cache:
                status, data = self.imap.uid("FETCH", uid, "(BODY.PEEK[])")
                raw = next((part[1] for part in data or [] if isinstance(part, tuple)), None)
                if status != "OK" or raw is None:
                    continue
                self._cache[uid] = message_to_dict(raw)
            results.append(self._cache[uid])
        return results

    def close(self):
        try:
            self.imap.logout()
        except Exception:
            pass


# ── Sync ─────────────────────────────────────────────────────────────────────

def company_variants(company: str) -> set[str]:
    return {v for v in {
        company.lower(),
        re.sub(r"\.(com|io|ai|co|inc|llc|ltd|org|net)$", "", company, flags=re.IGNORECASE).lower().strip(),
        re.sub(r",?\s*(inc\.?|llc\.?|ltd\.?|corp\.?)$", "", company, flags=re.IGNORECASE).lower().strip(),
    } if v}


def enrich_from_email(api: TrackerAPI, body: str) -> dict:
    """Use a job link found in the email to fill in posting details."""
    url = extract_url_from_email_body(body)
    if not url:
        return {}
    try:
        parsed = api.parse_job(url) or {}
    except Exception as exc:
        print(f"    parse-job failed for {url}: {exc}", file=sys.stderr)
        return {"url": url}
    enrichment = {"url": url}
    for key in ("location", "salaryBase", "salaryRsu", "salaryBonus", "salaryTotal",
                "rtoDays", "rtoNotes", "notes", "postedAt"):
        val = parsed.get(key)
        if val not in (None, "", []):
            enrichment[key] = val
    if parsed.get("role"):
        enrichment["parsedRole"] = parsed["role"]
    return enrichment


def run(api: TrackerAPI, gmail, days: int = 2, dry_run: bool = False) -> dict:
    log_path = data_dir() / "gmail_sync_decisions.jsonl"

    def log(event, company, role, status_from, status_to, reason, mail=None):
        mail = mail or {}
        with open(log_path, "a") as f:
            f.write(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(), "dry_run": dry_run, "event": event,
                "company": company, "role": role, "status_from": status_from, "status_to": status_to,
                "reason": reason, "email_subject": mail.get("subject", ""), "email_from": mail.get("from_", ""),
                "email_date": mail.get("date", ""), "email_snippet": mail.get("snippet", "")[:300],
            }) + "\n")

    jobs = api.jobs()
    window = f"newer_than:{days}d"
    updates, added, errors = [], [], []
    print(f"Loaded {len(jobs)} tracked job(s). Searching the last {days} day(s) of mail.")

    # Part 1: status updates for tracked jobs
    for job in jobs:
        company, role, current = job["company"], job.get("role", ""), job["status"]
        if current in TERMINAL:
            continue
        try:
            best, best_mail = None, None
            for mail in gmail.search([f"{_quote(company)} {window}"]):
                combined = f"{mail['subject']} {mail['snippet']} {mail['body'][:600]} {mail['from_']}".lower()
                if not any(v in combined for v in company_variants(company)):
                    log("skip", company, role, current, None, "company name not found in email", mail)
                    continue
                status = classify_email(mail["subject"], mail["body"], mail["snippet"], company)
                if status and is_progression(current, status):
                    if best is None or STATUS_ORDER.index(status) > STATUS_ORDER.index(best):
                        best, best_mail = status, mail
                elif status:
                    log("skip", company, role, current, status, f"not a progression from '{current}'", mail)
            if best:
                patch = {"status": best}
                if best == "Applied" and not job.get("appliedAt"):
                    patch["appliedAt"] = parse_email_date(best_mail["date"])
                if not dry_run:
                    api.update_job(job["id"], patch)
                updates.append((company, role, current, best))
                log("status_change", company, role, current, best, "signal matched and progression confirmed", best_mail)
                print(f"  {company}: {current} -> {best}")
        except Exception as exc:
            errors.append(f"{company}: {exc}")

    # Part 2: new applications not yet tracked
    try:
        phrases = ["thank you for applying", "application received",
                   "thank you for your application", "we have received your application"]
        seen = set()
        for mail in gmail.search([f"{_quote(p)} {window}" for p in phrases]):
            if not is_application_confirmation(mail["subject"], mail["body"], mail["snippet"], mail["from_"]):
                continue
            company = extract_company_from_email(mail["subject"], mail["body"], mail["from_"])
            if not company or company.lower() in seen or already_tracked(company, jobs):
                continue
            seen.add(company.lower())
            role = extract_role_from_email(mail["subject"], mail["body"]) or ""
            enrichment = {} if dry_run else enrich_from_email(api, mail["body"])
            parsed_role = enrichment.pop("parsedRole", "")
            payload = {"company": company, "role": role or parsed_role or "Unknown Role", "status": "Applied",
                       "appliedAt": parse_email_date(mail["date"]), "source": "Gmail (auto-detected)", **enrichment}
            if not dry_run:
                api.create_job(payload)
            added.append((company, payload["role"], payload["appliedAt"]))
            log("new_job_added", company, payload["role"], None, "Applied", "application confirmation email", mail)
            print(f"  New: {company} - {payload['role']} (applied {payload['appliedAt']})")
    except Exception as exc:
        errors.append(f"discovery: {exc}")

    return {"updates": updates, "added": added, "errors": errors}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Sync job application emails into the tracker.")
    parser.add_argument("--dry-run", action="store_true", help="show what would change without writing")
    parser.add_argument("--days", type=int, default=int(setting("GMAIL_LOOKBACK_DAYS", "2")),
                        help="how many days of mail to search (default 2)")
    args = parser.parse_args(argv)

    address, app_password = setting("GMAIL_ADDRESS"), setting("GMAIL_APP_PASSWORD")
    if not address or not app_password:
        print("Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env to enable Gmail sync.", file=sys.stderr)
        return 2
    gmail = Gmail(address, app_password.replace(" ", ""))
    try:
        result = run(TrackerAPI(), gmail, days=args.days, dry_run=args.dry_run)
    finally:
        gmail.close()

    lines = [f"- {c} ({r}): {a} -> {b}" for c, r, a, b in result["updates"]]
    lines += [f"- New: {c} - {r} (applied {d})" for c, r, d in result["added"]]
    prefix = "[dry run] " if args.dry_run else ""
    print(f"\n{prefix}{len(result['updates'])} status update(s), {len(result['added'])} new application(s).")
    for err in result["errors"]:
        print(f"  error: {err}", file=sys.stderr)
    if lines and not args.dry_run:
        notify(f"TabLess: {len(lines)} update(s) from Gmail", "\n".join(lines))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
