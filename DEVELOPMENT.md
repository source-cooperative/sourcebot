# Development

## Setup

### 1. Create the Scooter GitHub App

Create a new GitHub App in the `source-cooperative` organization with:

**Repository permissions:**

- Contents: Read & Write
- Issues: Read & Write
- Pull requests: Read & Write
- Metadata: Read (mandatory)

**Subscribe to events:** Issues

**Installation:** Restrict to the `source-cooperative` account.

After creating the App, generate a private key (.pem file) and note the **App ID**.

Install the App on the `source-cooperative` organization, granting access to `sourcebot`, `source.coop`, and `data.source.coop`. Note the **Installation ID** from the post-install URL.

### 2. Create the Cloudflare D1 Database

```bash
wrangler d1 create sourcebot
```

Note the **Database ID** from the output.

### 3. Create the Cloudflare API Token

At https://dash.cloudflare.com/profile/api-tokens, create a Custom Token with:

- Account → D1: Edit
- Account → Workers Observability: Read
- Account → Account Analytics: Read

Scope to your specific account.

### 4. Get the Vercel API Token

At https://vercel.com/account/tokens, create a token scoped to the `source-cooperative` team.

### 5. Get the Anthropic API Key

At https://console.anthropic.com/settings/keys, create a key named `sourcebot`. Add billing credits or a payment method.

### 6. Configure GitHub Variables and Secrets

**Organization-level** (grant access to `sourcebot`, `source.coop`, and `data.source.coop`):

| Type     | Name                     |
| -------- | ------------------------ |
| Variable | `SC_DEV_BOT_APP_ID`      |
| Secret   | `SC_DEV_BOT_PRIVATE_KEY` |
| Secret   | `ANTHROPIC_API_KEY`      |

**Repo-level** (sourcebot only):

| Type     | Name                         |
| -------- | ---------------------------- |
| Variable | `SC_DEV_BOT_INSTALLATION_ID` |
| Variable | `CLOUDFLARE_ACCOUNT_ID`      |
| Variable | `D1_DATABASE_ID`             |
| Variable | `VERCEL_TEAM_ID`             |
| Secret   | `CLOUDFLARE_API_TOKEN`       |
| Secret   | `VERCEL_API_TOKEN`           |

### 7. Initialize the D1 Schema

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export D1_DATABASE_ID=...
./scripts/init-d1.sh
```

### 8. Install Caller Workflows in Target Repos

Copy `caller-workflows/sourcebot-fix.yml` to `.github/workflows/sourcebot-fix.yml` in `source.coop` and `data.source.coop`.

### 9. Trigger the First Run

In the sourcebot repo's Actions tab, run **Sourcebot Monitor** manually via *Run workflow*. Verify it completes without errors.

## Configuration

`config.yaml` controls which repos to monitor and whether to auto-assign fixes:

```yaml
repos:
  - name: source-cooperative/source.coop
    log_source: vercel
    vercel_project_id: prj_xxx
    auto_fix: false

  - name: source-cooperative/data.source.coop
    log_source: cloudflare_workers
    cloudflare_script_name: data-source-coop
    auto_fix: true

schedule: "0 */6 * * *"
comment_cadence_days: 7
anthropic_model: claude-sonnet-4-6
```

When `auto_fix: true`, the monitor self-assigns new issues to Scooter, triggering the fix workflow automatically.

## Local Development

```bash
npm install
npm test           # Run test suite (vitest)
npm run lint       # Type check (tsc --noEmit)
npm run monitor    # Run the monitor locally (requires env vars)
```

## Project Structure

```
sourcebot/
├── .github/workflows/
│   ├── monitor.yml          Cron monitor
│   ├── fix.yml              Reusable fix workflow
│   └── ci.yml               Test and type-check on PRs
├── caller-workflows/
│   └── sourcebot-fix.yml    Copy to target repos
├── scripts/
│   └── init-d1.sh           One-time schema setup
├── src/
│   ├── index.ts             Main orchestrator + CLI entry
│   ├── config.ts            Load config.yaml
│   ├── d1.ts                D1 REST API client
│   ├── github.ts            GitHub App auth + issue management
│   ├── fingerprint.ts       Error normalization and hashing
│   ├── classifier.ts        Anthropic API for error grouping
│   └── sources/
│       ├── vercel.ts        Vercel runtime logs
│       └── cloudflare.ts    Workers Observability
├── config.yaml              Which repos to monitor
└── schema.sql               D1 schema
```
