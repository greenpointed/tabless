#!/usr/bin/env python3
"""Daily job-link check.

Reads active jobs from your tracker, checks each posting URL and records
which postings look closed:

- HTTP 404/410 responses and redirects to a generic careers page
- "soft 404" pages that load but say the job is closed or filled
- HTTP 403, timeouts and 5xx errors are reported as inconclusive warnings

Each run appends to `url_check_log.jsonl` and writes a Markdown report
`job-url-check-YYYY-MM-DD.md` in the automation data folder, including what
was newly flagged or resolved since the previous run. Application statuses
are never changed. Optional: set NOTIFY_WEBHOOK_URL to get a message when
issues are found.

Usage:  python3 automation/url_check.py [--no-delay]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

from common import TrackerAPI, data_dir, notify

EXCLUDED_STATUSES = {"Rejected", "Withdrawn", "Offer"}

# HTTP statuses that mean the job is definitely gone
GONE_STATUSES = {404, 410}

# Soft-404 phrases: page returns 200 but the job is no longer listed
SOFT_404_PATTERNS = [
    r"this (job|position|listing|posting|role|opening) (is no longer|has been|is not) (available|active|open|accepting|listed|filled)",
    r"(job|position|listing|posting|role|opening) (has been |is )(closed|filled|expired|removed|taken down|no longer available)",
    r"no longer accepting applications",
    r"this (requisition|req) (is|has been) (closed|filled|inactive)",
    r"(we('re| are) sorry|unfortunately)[^.]{0,80}(no longer|not) (available|accepting|open)",
    r"position (has been |is )filled",
    r"this listing has expired",
    r"job (no longer |not )available",
    r"we('ve| have) (filled|closed) this (position|role|opening|job)",
    r"(404|page not found|not found)[^.]{0,30}(job|position|role)",
]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def soft_404_pattern(text: str):
    """Ignore conditional deadlines, but retain separate actual closure notices."""
    text = re.sub(
        r"\b(?:until|unless|before|if|once|when)\s+"
        r"(?:(?:the|this|that|a)\s+)?"
        r"(?:job|position|listing|posting|role|opening|requisition|req)\s+"
        r"(?:has been|is)\s+"
        r"(?:closed|filled|expired|removed|taken down|no longer available)\b",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return next(
        (pat for pat in SOFT_404_PATTERNS if re.search(pat, text, re.IGNORECASE)),
        None,
    )


class PageText(HTMLParser):
    """Check rendered prose, not script/style translation dictionaries."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "template", "noscript"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "template", "noscript") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def page_text(body: str) -> str:
    parser = PageText()
    parser.feed(body)
    return " ".join(" ".join(parser.parts).split()).lower()


def check_url(url: str) -> dict:
    """
    Check whether a job URL is still live.
    Returns a dict: {status_code, ok, issue, redirect_url, soft_404}
    """
    result = {
        "status_code": None,
        "ok": True,
        "issue": None,
        "redirect_url": None,
        "soft_404": False,
    }

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            method="GET",
        )
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())
        with opener.open(req, timeout=12) as resp:
            result["status_code"] = resp.status
            final_url = resp.url

            # Check for redirects to generic pages (not the original job)
            if final_url and final_url.rstrip("/") != url.rstrip("/"):
                result["redirect_url"] = final_url
                path = final_url.split("//")[-1].split("/", 1)[-1].strip("/")
                if not path or path in ("jobs", "careers", "search", "404"):
                    result["ok"] = False
                    result["issue"] = f"Redirected to generic page: {final_url}"
                    return result

            # Read up to 50KB of body to check for soft-404 signals
            body = resp.read(50_000).decode("utf-8", errors="ignore")
            body_lower = page_text(body)

            pat = soft_404_pattern(body_lower)
            if pat:
                result["ok"] = False
                result["soft_404"] = True
                result["issue"] = f"Job appears to be closed (soft-404 pattern matched: '{pat[:60]}')"
                return result

    except urllib.error.HTTPError as e:
        result["status_code"] = e.code
        if e.code in (404, 410):
            result["ok"] = False
            result["issue"] = f"HTTP {e.code} — page not found / gone"
        elif e.code == 403:
            result["ok"] = True  # bot-blocked, can't verify
            result["issue"] = f"HTTP 403 — access blocked (can't verify)"
        elif e.code >= 500:
            result["ok"] = True  # server error, not conclusive
            result["issue"] = f"HTTP {e.code} — server error (inconclusive)"
        else:
            result["ok"] = False
            result["issue"] = f"HTTP {e.code}"
    except urllib.error.URLError as e:
        result["ok"] = False
        result["issue"] = f"URL error: {e.reason}"
    except TimeoutError:
        result["ok"] = True  # timeout ≠ gone
        result["issue"] = "Timeout — could not verify"
    except Exception as e:
        result["ok"] = True  # unknown error, don't false-alarm
        result["issue"] = f"Check failed: {e}"

    return result



def active_jobs(api: TrackerAPI) -> list[dict]:
    return [j for j in api.jobs()
            if (j.get("url") or "").strip() and j.get("status") not in EXCLUDED_STATUSES]


def _md(text) -> str:
    return str(text or "").replace("|", "\\|").replace("\n", " ")


def write_report(path, run_ts: str, results: list[tuple[dict, dict]], newly: set, resolved: set) -> None:
    issues = [(j, c) for j, c in results if not c["ok"]]
    warnings = [(j, c) for j, c in results if c["ok"] and c["issue"]]
    clean = len(results) - len(issues) - len(warnings)
    day = run_ts[:10]
    lines = [
        f"# Job URL Check: {day}", "",
        f"Checked {len(results)} URLs. {len(issues)} unavailable, {len(warnings)} inconclusive, {clean} with no issue.",
        f"Since the previous run: {len(newly)} newly flagged, {len(resolved)} resolved.", "",
        f"Run timestamp: {run_ts}.", "",
        "## Unavailable postings", "",
    ]
    if issues:
        lines += ["| Company | Role | Tracker ID | Finding | URL |", "|---|---|---|---|---|"]
        for j, c in sorted(issues, key=lambda x: (str(x[0].get("company", "")).lower(), x[0]["id"])):
            new = " (new)" if j["id"] in newly else ""
            lines.append(f"| {_md(j.get('company'))} | {_md(j.get('role'))} | {j['id']}{new} | {_md(c['issue'])} | [Posting]({j['url']}) |")
    else:
        lines.append("None.")
    lines += ["", "## Inconclusive warnings", ""]
    if warnings:
        for j, c in warnings:
            lines.append(f"- **{_md(j.get('company'))}: {_md(j.get('role'))}**: {_md(c['issue'])}; tracker ID {j['id']}, [checked URL]({j['url']}).")
    else:
        lines.append("None.")
    lines += ["", "## Method", "",
              "HTTP 404/410 responses, generic-careers redirects and closure wording indicate an "
              "unavailable posting, not proof that the role was filled. Blocked (403) pages and "
              "timeouts cannot be verified. No application statuses were changed.", ""]
    path.write_text("\n".join(lines))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-delay", action="store_true", help="skip the polite pause between requests")
    args = parser.parse_args(argv)

    out = data_dir()
    state_path = out / "url_check_state.json"
    previous = set(json.loads(state_path.read_text()).get("issue_job_ids", [])) if state_path.exists() else set()

    run_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    jobs = active_jobs(TrackerAPI())
    print(f"Checking {len(jobs)} job URLs (run {run_ts})")

    results = []
    with open(out / "url_check_log.jsonl", "a") as log:
        for i, job in enumerate(jobs):
            check = check_url(job["url"])
            results.append((job, check))
            log.write(json.dumps({"run_ts_utc": run_ts, "job_id": job["id"], "company": job.get("company"),
                                  "role": job.get("role"), "status": job.get("status"), "url": job["url"],
                                  "http_status": check["status_code"], "ok": check["ok"], "issue": check["issue"],
                                  "soft_404": check["soft_404"], "redirect_url": check["redirect_url"]}) + "\n")
            mark = "ISSUE" if not check["ok"] else ("WARN " if check["issue"] else "ok   ")
            print(f"  {mark} {job.get('company')} - {str(job.get('role'))[:50]} {check['issue'] or ''}")
            if not args.no_delay and i < len(jobs) - 1:
                time.sleep(1.5)

    current = {j["id"] for j, c in results if not c["ok"]}
    newly, resolved = current - previous, previous - current
    report = out / f"job-url-check-{run_ts[:10]}.md"
    write_report(report, run_ts, results, newly, resolved)
    state_path.write_text(json.dumps({"last_run_utc": run_ts, "checked": len(results),
                                      "issue_job_ids": sorted(current)}, indent=2))
    print(f"\n{len(current)} issue(s), {len(newly)} new, {len(resolved)} resolved. Report: {report}")

    if newly:
        body = "\n".join(f"- {j.get('company')} - {j.get('role')}: {c['issue']}\n  {j['url']}"
                          for j, c in results if j["id"] in newly)
        notify(f"TabLess: {len(newly)} posting(s) newly unavailable", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
