#!/usr/bin/env bash
# Configure merge settings and the `main` ruleset for githonllc/ainews.
# Safe to run again. Needs `gh` logged in with admin rights on the repo.
# Run it after the `ci` check has reported at least once on a PR.
#
# Usage: bash scripts/github-setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

REPO="githonllc/ainews"
RULESET_FILE="scripts/github/ruleset-main.json"

# Merge settings: squash only, auto-merge on, delete branch after merge.
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true \
  --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}'

# Ruleset `main`: update when it exists, create otherwise.
ruleset_id="$(
  gh api "repos/$REPO/rulesets" --paginate \
    --jq '.[] | select(.name == "main") | .id' | head -n 1
)"
if [[ -n "$ruleset_id" ]]; then
  echo "Ruleset main ($ruleset_id): updating"
  gh api -X PUT "repos/$REPO/rulesets/$ruleset_id" \
    --input "$RULESET_FILE" --jq '{id, name, enforcement}'
else
  echo "Ruleset main: creating"
  gh api -X POST "repos/$REPO/rulesets" \
    --input "$RULESET_FILE" --jq '{id, name, enforcement}'
fi
