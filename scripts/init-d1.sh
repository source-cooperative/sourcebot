#!/usr/bin/env bash
set -euo pipefail

# Initialize the D1 database schema for sourcebot.
# Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID env vars.

: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${D1_DATABASE_ID:?Set D1_DATABASE_ID}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA=$(cat "${SCRIPT_DIR}/../schema.sql")

# D1 REST API requires individual statements — split by semicolons
while IFS= read -r stmt; do
  stmt=$(echo "$stmt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$stmt" ] && continue

  echo "Executing: ${stmt:0:60}..."
  result=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"sql\": \"${stmt}\"}")

  success=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "false")
  if [ "$success" != "True" ]; then
    echo "Warning: Statement may have failed: $result"
  fi
done <<< "$(echo "$SCHEMA" | tr '\n' ' ' | sed 's/;/;\n/g')"

echo "D1 schema initialized."
