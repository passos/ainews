#!/usr/bin/env bash
# Create the Cloudflare resources that wrangler.jsonc binds to.
# Safe to run again: each resource is created only when it does not exist.
# Needs real credentials (wrangler login, or CLOUDFLARE_API_TOKEN).
# The account comes from `account_id` in wrangler.jsonc (it wins over
# CLOUDFLARE_ACCOUNT_ID). `--update-config=false` keeps the create commands
# from prompting or editing wrangler.jsonc.
#
# Usage: bash scripts/provision.sh
set -euo pipefail

cd "$(dirname "$0")/.."

wrangler() { npx --no-install wrangler "$@"; }

D1_NAME="ainews"
R2_BUCKET="ainews-bodies"
QUEUES=(ainews-ingest ainews-group ainews-generate ainews-dlq)
VECTOR_INDEXES=(ainews-events ainews-chunks)
VECTOR_DIMENSIONS=1024
VECTOR_METRIC=cosine

d1_id() {
  wrangler d1 list --json | jq -r --arg name "$D1_NAME" \
    '.[] | select(.name == $name) | .uuid'
}

# D1
if [[ -n "$(d1_id)" ]]; then
  echo "D1 $D1_NAME: exists"
else
  echo "D1 $D1_NAME: creating"
  wrangler d1 create "$D1_NAME" --update-config=false
fi

# R2
if wrangler r2 bucket info "$R2_BUCKET" --json >/dev/null 2>&1; then
  echo "R2 $R2_BUCKET: exists"
else
  echo "R2 $R2_BUCKET: creating"
  wrangler r2 bucket create "$R2_BUCKET" --update-config=false
fi

# Queues. Consumers and the dead letter queue link are set by `wrangler deploy`.
for queue in "${QUEUES[@]}"; do
  if wrangler queues info "$queue" >/dev/null 2>&1; then
    echo "Queue $queue: exists"
  else
    echo "Queue $queue: creating"
    wrangler queues create "$queue"
  fi
done

# Vectorize
for index in "${VECTOR_INDEXES[@]}"; do
  if wrangler vectorize get "$index" --json >/dev/null 2>&1; then
    echo "Vectorize $index: exists"
  else
    echo "Vectorize $index: creating"
    wrangler vectorize create "$index" \
      --dimensions="$VECTOR_DIMENSIONS" --metric="$VECTOR_METRIC" \
      --update-config=false
  fi
done

# Vectorize metadata index: ainews-events.industry_id (number)
has_industry_index="$(
  wrangler vectorize list-metadata-index ainews-events --json |
    jq -r '[.[] | select(.propertyName == "industry_id")] | length'
)"
if [[ "$has_industry_index" != "0" ]]; then
  echo "Vectorize ainews-events metadata index industry_id: exists"
else
  echo "Vectorize ainews-events metadata index industry_id: creating"
  wrangler vectorize create-metadata-index ainews-events \
    --propertyName=industry_id --type=number
fi

id="$(d1_id)"
if [[ -z "$id" ]]; then
  echo "error: D1 $D1_NAME not found after create" >&2
  exit 1
fi
echo
echo "D1 database_id: $id"
echo "Put this value in wrangler.jsonc (d1_databases[0].database_id)."
