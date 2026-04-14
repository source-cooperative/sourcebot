# Caller Workflows

Copy `sourcebot-fix.yml` to `.github/workflows/sourcebot-fix.yml` in each target repo:

- `source-cooperative/source.coop`
- `source-cooperative/data.source.coop`

The target repos must also have the sourcebot GitHub App installed and the following available at the organization level:

**Secrets** (inherited via `secrets: inherit`):
- `ANTHROPIC_API_KEY`
- `SC_DEV_BOT_PRIVATE_KEY`

**Variables** (automatically accessible to all workflows in the org):
- `SC_DEV_BOT_APP_ID`
