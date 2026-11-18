# Job Tracker

A self-hosted, single-owner job application tracker with list and kanban views,
contacts, action items, compensation fields, and optional AI relevance scoring.

This distribution contains code only. It has no job records, contacts, resume,
email history, account credentials, or connection to the original installation.
Every installation requires its own database and credentials.

## Start with an empty instance

1. Install Node.js 22.12+ and npm, then clone this repository.
2. Create a NEW empty Supabase project. Run `supabase/schema.sql` in that
   project's SQL editor. Do not run it against an existing personal database.
   The script creates tables only, inserts no records, and contains no reset or
   delete operations.
3. Run `npm ci`, then copy `.env.example` to `.env`.
4. Fill `SUPABASE_URL` and `SUPABASE_KEY` with YOUR project's URL and server-side
   secret/service-role key. Set `APP_USERNAME` and a unique `APP_PASSWORD` of at
   least 16 characters. Never use `VITE_` variables for secrets.
5. Run `npm run build` and `npm start`. Visit `http://127.0.0.1:5000` and enter
   your configured username and password in the browser's authentication prompt.
   The tracker starts empty because the new database contains no records.

For development use `npm run dev`. Run authentication tests with
`node --import tsx --test tests/*.test.ts`.

The shared Drizzle schema uses SQLite types for validation; runtime persistence
uses Supabase/PostgreSQL. Do not use `npm run db:push` to provision Supabase.

## Optional relevance scoring

Leave `OPENAI_API_KEY` and `RESUME_FILE` blank to disable scoring. To enable it,
put your own plain-text resume in `private/resume.txt` and set both variables.
Restart after changing the file. The `private/` directory is Git-ignored.
The configured model receives your resume plus job title, company and description;
requests use your own provider account and may incur charges.
`OPENAI_MODEL` is configurable.

## Security and deployment

The app is a single-owner tool, not a multi-user service. HTTP Basic authentication
protects all routes. Always put a remotely accessible deployment behind HTTPS,
restrict access with a VPN or identity-aware proxy, and apply rate limits at the
proxy. Set `APP_ORIGIN` to your exact public HTTPS origin to allow browser writes.
Set `HOST=0.0.0.0` only if your hosting environment needs external binding.
Basic authentication is not encrypted on plain HTTP.

Supabase row-level security is enabled without public client policies; only the
backend's privileged key accesses the database. A service-role/secret key bypasses
RLS, so protecting the backend remains essential. Never share your own hosted
instance's environment configuration with people forking this code.

URL parsing fetches external websites and is intended for trusted owner input.
Do not expose this tool as an unrestricted public service: URL-fetching routes
have not been hardened against all SSRF/redirect/DNS-rebinding cases.
Third-party sites can block extraction or change their markup.
No public hosting security audit or dependency vulnerability remediation is
claimed by this source cleanup.

## Date Posted

When you add a job by URL, "Date Posted" is the earliest known date the posting
was first published, not a refreshed "posted" date shown on a reposted listing.
The server takes the earliest of the ATS original date (Greenhouse
`first_published`, Ashby `publishedDate`, Lever `createdAt`, Workday
`startDate`), the earliest Wayback Machine capture of the URL, and any date
found on the page. Lookups that fail or are blocked are skipped.

## Optional automation

Two standard-library Python 3.10+ scripts in `automation/` talk to your running
tracker with the same `APP_USERNAME`/`APP_PASSWORD` and read settings from `.env`.
Output goes to `automation-data/` (Git-ignored): it will contain your own job
and email details, so never commit it.

### Daily job-link check

```sh
python3 automation/url_check.py
```

Checks every active job's posting URL (skipping Offer, Rejected and Withdrawn)
and writes `automation-data/job-url-check-YYYY-MM-DD.md`, a report of postings
that look closed (404/410, redirect to a generic careers page, or "position
filled" wording), inconclusive warnings (403 blocks, timeouts), and what was
newly flagged or resolved since the last run. Raw results are appended to
`url_check_log.jsonl`. It never changes application statuses.

### Gmail sync

Connects to your own Gmail over IMAP, read-only, and:

- moves tracked jobs forward when it finds a clear confirmation, phone screen,
  interview, offer or rejection email (never out of Offer/Rejected/Withdrawn);
- adds new "thank you for applying" applications for companies not yet tracked,
  using any job link in the email to fill in details.

Setup: enable 2-Step Verification on your Google account, create an app
password at https://myaccount.google.com/apppasswords, and set `GMAIL_ADDRESS`
and `GMAIL_APP_PASSWORD` in `.env`. Try it first without writing anything:

```sh
python3 automation/gmail_sync.py --dry-run --days 14
```

Every decision (including skips and why) is logged to
`automation-data/gmail_sync_decisions.jsonl`. The app password grants mailbox
access: keep it only in `.env`, and revoke it from your Google account if it is
ever exposed. Email matching uses keyword rules, so review changes periodically.

### Scheduling and notifications

Run both daily with cron (`crontab -e`), adjusting the path:

```cron
0 9  * * * cd /path/to/job-tracker && python3 automation/gmail_sync.py >> automation-data/cron.log 2>&1
0 10 * * * cd /path/to/job-tracker && python3 automation/url_check.py  >> automation-data/cron.log 2>&1
```

Set `NOTIFY_WEBHOOK_URL` to a Slack, Discord or similar incoming webhook to get
a message when Gmail sync changes something or a posting is newly unavailable.
Run the automation tests with `python3 -m unittest discover -s automation/tests`.

## Contributing

Never commit `.env`, `private/`, `automation-data/`, databases, logs, builds, or personal exports.

## Scope

This repository contains no job records, résumé, email content or reports from
any existing installation, and no demo/seed data. Nothing in it is connected to
anyone else's database, Gmail or notification channel.

## License

MIT. See [LICENSE](LICENSE).
