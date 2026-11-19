# sourcebot

Automated error monitoring and triage bot for Source Cooperative. Runs as a GitHub Action on a 6-hour schedule, fetches errors from Vercel and Cloudflare Workers, and creates GitHub issues for new errors. When a human assigns an issue to the bot, it implements a fix and opens a PR.

The GitHub App is named **Scooter** (Source Cooperative Operator for Observation, Triage, Engineering, and Repair).

## What It Does

**Monitor workflow** (runs every 6 hours):

- Fetches runtime errors from Vercel for `source.coop`
- Fetches Cloudflare's Workers Observability Issues (its own grouping of exceptions, 5xx responses and ERROR lines) for `data.source.coop`, skipping vulnerability-scan detections
- Computes a fingerprint for each error (normalized message + stack location + status code)
- Groups new errors via the Anthropic API and creates GitHub issues in the appropriate target repo
- Reopens closed issues when the same error recurs on a newer release version
- Comments weekly on open issues with updated occurrence counts

**Digest workflow** (Mondays 16:00 UTC):

- Gathers the past week of the data proxy's observability: alert notifications and monitor definitions, Workers Issues, Analytics Engine traffic (daily requests and 5xx, read p99 and its worst 15-minute windows, top 5xx and busiest products), Workers Logs WARN/ERROR volume and top sources, and `data.source.coop`'s open issues
- Has Claude write a short review (which alerts were real, what drove errors and latency, which noise sources are tracked by an open issue and which are not, suggested actions) and posts it to Slack
- Only suggests: it files no issues and changes no monitors

Both scheduled workflows re-enable themselves on each run, so GitHub's 60-day inactivity rule does not switch them off.

**Fix workflow** (triggered by issue assignment):

- Runs when a human assigns an issue to `scooter[bot]`
- Checks out the target repo, reads its PR template
- Runs Claude Code to implement the fix on a new branch
- Opens a PR filling in the repo's PR template, requesting review from the assigner

State lives in Cloudflare D1, accessed via its REST API.

## Architecture

```
GitHub Actions (this repo)
├── monitor.yml    Cron: fetch logs → classify → create/update issues
├── digest.yml     Weekly: gather proxy observability → summarize → Slack
└── fix.yml        Reusable: called from target repos on issue assignment

Target repos (source.coop, data.source.coop)
└── sourcebot-fix.yml   Thin caller: forwards issue.assigned events
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup and local development.
