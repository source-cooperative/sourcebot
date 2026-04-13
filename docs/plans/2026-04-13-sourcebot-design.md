# Sourcebot Design

An automated error monitoring and triage bot for Source Cooperative. Sourcebot checks logs from Vercel and Cloudflare Workers on a schedule, creates GitHub Issues for new errors, tracks known errors, and can implement fixes when assigned to an issue.

## Architecture

GitHub Actions handles both scheduled monitoring and issue-fix workflows. State lives in Cloudflare D1, accessed via its REST API.

```
GitHub Actions (sourcebot repo)
├── monitor.yml (cron: every 6 hours)
│   ├── Fetch errors from Vercel API (source.coop)
│   ├── Fetch errors from CF Workers Observability API (data.source.coop)
│   ├── Query D1 for known error fingerprints
│   ├── Classify new errors via Anthropic API
│   ├── Create issues in target repos (source.coop or data.source.coop)
│   ├── Reopen closed issues if error recurs on a new release
│   ├── Comment on open issues weekly with updated frequency
│   └── Update D1 state
│
└── fix.yml (reusable workflow, called from target repos)
    ├── Triggered by issue assignment to sourcebot
    ├── Check out the target repo
    ├── Run Claude Code with issue context
    ├── Open PR using the repo's PR template
    └── Assign PR to the person who assigned the issue

Target repos (thin caller workflow)
├── source.coop/.github/workflows/sourcebot-fix.yml
└── data.source.coop/.github/workflows/sourcebot-fix.yml
```

## Log Sources

### Vercel (source.coop)

- **API:** Vercel REST API `/v1/projects/{project_id}/logs`
- **Project ID:** `prj_uU5LXO7OUjHYb0nC1AKjTqQKW0Yj`
- **Filters:** Runtime errors, unhandled exceptions, 5xx responses
- **Release version:** Git SHA from deployment metadata, mapped to semver via release-please tags

### Cloudflare Workers (data.source.coop)

- **API:** Cloudflare Workers Observability API (traces and logs)
- **Script name:** `data-source-coop` (production)
- **Observability:** 100% sampling rate, invocation logs and traces enabled
- **Filters:** Error-level logs, non-2xx status codes, exceptions
- **Release version:** Git SHA from Worker deployment metadata
- **Analytics Engine dataset:** `source_data_proxy_production` (for future usage tracking)

## Error Classification and Deduplication

### Fingerprinting

Each error gets a fingerprint computed by:

1. Normalizing the error message (strip timestamps, request IDs, UUIDs, variable data)
2. Extracting the stack trace location (file + line number + function name)
3. Including the HTTP status code
4. Hashing the normalized tuple (SHA-256, truncated)

### Triage Flow

For each error found during a monitoring run:

1. **New fingerprint** → batch with other new errors → send to Anthropic API for classification and grouping → create an issue in the target repo with: error summary, sample stack trace, occurrence count in this window, release version(s) seen, likely cause. Optionally self-assign if `auto_fix: true` for that repo.

2. **Known fingerprint, open issue** → increment count in D1. If `last_commented_at` is more than 7 days ago, add a comment with updated stats (occurrences since last comment, total count, release versions).

3. **Known fingerprint, closed issue, new release version** → reopen the issue with a comment: "This error reappeared on release `vX.Y.Z` (N occurrences in the last 6 hours). Either the fix didn't address this case or there was a regression." Update D1 with new release version.

4. **Known fingerprint, closed issue, same release version** → no action (error predates the fix, still draining from logs).

### What Claude Does

- Writes human-readable issue titles and descriptions
- Groups related errors (e.g., same root cause manifesting differently)
- Suggests probable cause based on stack trace and error message
- Does NOT assign severity or priority labels — that stays with humans

## Issue Fix Workflow

### Trigger

A human (or the monitor workflow via auto-assign) assigns an issue to `sourcebot[bot]` in a target repo.

### Flow

1. Target repo's thin workflow (`.github/workflows/sourcebot-fix.yml`) fires on `issues.assigned`
2. Checks that the assignee is the sourcebot GitHub App
3. Calls the reusable workflow `source-cooperative/sourcebot/.github/workflows/fix.yml`
4. The reusable workflow:
   - Checks out the target repo
   - Reads the repo's `.github/pull_request_template.md`
   - Runs Claude Code with context: issue body, repo structure, PR template
   - Claude Code creates a branch, implements a fix, opens a PR filling in the repo's PR template
   - Assigns the PR to the person who originally assigned the issue

### Target Repo Caller Workflow

Each target repo needs this thin workflow:

```yaml
# .github/workflows/sourcebot-fix.yml
name: Sourcebot Fix
on:
  issues:
    types: [assigned]
jobs:
  fix:
    if: github.event.assignee.login == 'sourcebot[bot]'
    uses: source-cooperative/sourcebot/.github/workflows/fix.yml@main
    secrets: inherit
```

### PR Templates

Target repos have existing PR templates that the fix workflow must respect:

- **source.coop:** Sections for "What I'm changing", "How I did it", "How you can test it"
- **data.source.coop:** Sections for "What I'm changing", "How I did it", "How to test it", "PR Checklist", "Related Issues"

Claude Code reads the template and fills in each section based on the changes made.

## D1 Schema

```sql
CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_location TEXT,
  http_status INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_count INTEGER DEFAULT 1,
  window_count INTEGER DEFAULT 0,
  release_versions TEXT DEFAULT '[]',
  github_issue_number INTEGER,
  github_issue_state TEXT,
  last_commented_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  errors_found INTEGER DEFAULT 0,
  issues_created INTEGER DEFAULT 0,
  issues_commented INTEGER DEFAULT 0,
  issues_reopened INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  log TEXT
);

CREATE INDEX idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX idx_errors_repo ON errors(repo);
CREATE INDEX idx_errors_issue_state ON errors(github_issue_state);
```

## Configuration

### config.yaml (in sourcebot repo)

```yaml
repos:
  - name: source-cooperative/source.coop
    log_source: vercel
    vercel_project_id: prj_uU5LXO7OUjHYb0nC1AKjTqQKW0Yj
    auto_fix: false

  - name: source-cooperative/data.source.coop
    log_source: cloudflare_workers
    cloudflare_script_name: data-source-coop
    auto_fix: true

schedule: "0 */6 * * *"

comment_cadence_days: 7

anthropic_model: claude-sonnet-4-6
```

### GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `VERCEL_API_TOKEN` | Fetch Vercel deployment logs |
| `CLOUDFLARE_API_TOKEN` | Workers Observability API + D1 REST API |
| `CLOUDFLARE_ACCOUNT_ID` | CF account identifier |
| `D1_DATABASE_ID` | Target D1 database |
| `ANTHROPIC_API_KEY` | Error classification |
| `SOURCEBOT_APP_ID` | GitHub App for issue/PR creation |
| `SOURCEBOT_APP_PRIVATE_KEY` | GitHub App authentication |

## Project Structure

```
sourcebot/
├── .github/
│   └── workflows/
│       ├── monitor.yml
│       └── fix.yml
├── src/
│   ├── index.ts
│   ├── sources/
│   │   ├── vercel.ts
│   │   └── cloudflare.ts
│   ├── classifier.ts
│   ├── github.ts
│   ├── d1.ts
│   └── config.ts
├── config.yaml
├── schema.sql
├── package.json
└── tsconfig.json
```

## GitHub App Setup

Create a new GitHub App named `sourcebot` with these permissions:

- **Repository permissions:**
  - Issues: Read & Write (create, comment, reopen, assign)
  - Pull requests: Read & Write (create PRs)
  - Contents: Read & Write (push branches)
  - Metadata: Read
- **Subscribe to events:**
  - Issues

Install the App on the `source-cooperative` organization, granting access to `source.coop`, `data.source.coop`, and `sourcebot` repos.

## Future Phases

### Phase 2: Usage Analytics

Query Cloudflare Analytics Engine (`source_data_proxy_production` dataset) for traffic patterns. Detect spikes by comparing current window to rolling average. Identify which product/account is driving the spike using the `account_id/product_id` index.

### Phase 3: Slack Integration

Post to a Slack channel via webhook when:
- A new error is detected and an issue is created
- A usage spike is detected (with product attribution)
- A fix PR is opened
