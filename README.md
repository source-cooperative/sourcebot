# sourcebot

Automated error monitoring and triage bot for Source Cooperative. Runs as a GitHub Action on a 6-hour schedule, fetches errors from Vercel and Cloudflare Workers, and creates GitHub issues for new errors. When a human assigns an issue to the bot, it implements a fix and opens a PR.

The GitHub App is named **Scooter** (Source Cooperative Operator for Observation, Triage, Engineering, and Repair).

## What It Does

**Monitor workflow** (runs every 6 hours):

- Fetches runtime errors from Vercel for `source.coop`
- Fetches error-level logs from Cloudflare Workers Observability for `data.source.coop`
- Computes a fingerprint for each error (normalized message + stack location + status code)
- Groups new errors via the Anthropic API and creates GitHub issues in the appropriate target repo
- Reopens closed issues when the same error recurs on a newer release version
- Comments weekly on open issues with updated occurrence counts

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
└── fix.yml        Reusable: called from target repos on issue assignment

Target repos (source.coop, data.source.coop)
└── sourcebot-fix.yml   Thin caller: forwards issue.assigned events
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup and local development.
