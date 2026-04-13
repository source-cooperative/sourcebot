# Caller Workflows

Copy `sourcebot-fix.yml` to `.github/workflows/sourcebot-fix.yml` in each target repo:

- `source-cooperative/source.coop`
- `source-cooperative/data.source.coop`

The target repos must also have the sourcebot GitHub App installed and the following secrets available (inherited from the organization):

- `ANTHROPIC_API_KEY`
- `SOURCEBOT_APP_ID`
- `SOURCEBOT_APP_PRIVATE_KEY`
