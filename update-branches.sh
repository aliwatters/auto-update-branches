#!/usr/bin/env bash
set -euo pipefail

# Auto-Update PR Branches
# Finds open PRs behind the base branch and updates them via GitHub API.
# Designed to run as a composite GitHub Action step.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "::notice::$*"; }
warn() { echo "::warning::$*"; }

# Convert comma-separated string to jq array filter
csv_to_jq_any() {
  local csv="$1"
  if [[ -z "$csv" ]]; then
    echo "false"
    return
  fi
  # Build: any(. == "wip") or any(. == "do-not-merge")
  local filter=""
  IFS=',' read -ra ITEMS <<< "$csv"
  for item in "${ITEMS[@]}"; do
    item=$(echo "$item" | xargs) # trim whitespace
    if [[ -n "$filter" ]]; then
      filter="$filter or "
    fi
    filter="${filter}any(. == \"$item\")"
  done
  echo "$filter"
}

# ---------------------------------------------------------------------------
# Gather open PRs
# ---------------------------------------------------------------------------

echo "::group::Discovering open PRs"

# Build the jq filter for eligible PRs based on INPUT_FILTER
LABEL_FILTER=$(csv_to_jq_any "$INPUT_EXCLUDE_LABELS")

# Fetch all open non-draft PRs with metadata
PRS=$(gh pr list --state open --json number,headRefName,headRefOid,isDraft,autoMergeRequest,labels \
  --jq "[.[] | select(.isDraft == false) | {
    number,
    branch: .headRefName,
    sha: .headRefOid,
    auto_merge: (.autoMergeRequest != null),
    has_label: ([.labels[].name] | any(. == \"$INPUT_LABEL\")),
    labels: [.labels[].name],
    excluded: ([.labels[].name] | $LABEL_FILTER)
  } | select(.excluded == false)]")

TOTAL=$(echo "$PRS" | jq 'length')
echo "Found $TOTAL open non-draft PR(s)"

# Apply filter
case "$INPUT_FILTER" in
  all)
    ELIGIBLE="$PRS"
    ;;
  auto-merge)
    ELIGIBLE=$(echo "$PRS" | jq '[.[] | select(.auto_merge)]')
    ;;
  label)
    ELIGIBLE=$(echo "$PRS" | jq '[.[] | select(.has_label)]')
    ;;
  auto-merge+label)
    ELIGIBLE=$(echo "$PRS" | jq '[.[] | select(.auto_merge or .has_label)]')
    ;;
  *)
    warn "Unknown filter '$INPUT_FILTER', defaulting to 'all'"
    ELIGIBLE="$PRS"
    ;;
esac

ELIGIBLE_COUNT=$(echo "$ELIGIBLE" | jq 'length')
echo "After filter ($INPUT_FILTER): $ELIGIBLE_COUNT eligible PR(s)"
echo "$ELIGIBLE" | jq -r '.[] | "  #\(.number) [\(.branch)] auto_merge=\(.auto_merge) label=\(.has_label)"'

if [[ "$ELIGIBLE_COUNT" == "0" ]]; then
  echo "No eligible PRs to update."
  echo "updated=0" >> "$GITHUB_OUTPUT"
  echo "conflicts=0" >> "$GITHUB_OUTPUT"
  echo "skipped=0" >> "$GITHUB_OUTPUT"
  echo "summary=No eligible PRs to update" >> "$GITHUB_OUTPUT"
  echo "::endgroup::"
  exit 0
fi

echo "::endgroup::"

# ---------------------------------------------------------------------------
# Update branches
# ---------------------------------------------------------------------------

UPDATED=0
CONFLICTS=0
SKIPPED=0
ERRORS=0
MAX=${INPUT_MAX_UPDATES:-0}

for PR_NUMBER in $(echo "$ELIGIBLE" | jq -r '.[].number'); do
  # Respect max-updates limit
  if [[ "$MAX" -gt 0 && "$UPDATED" -ge "$MAX" ]]; then
    echo "Reached max-updates limit ($MAX). Stopping."
    break
  fi

  echo "::group::PR #$PR_NUMBER"

  PR_SHA=$(echo "$ELIGIBLE" | jq -r --argjson n "$PR_NUMBER" '.[] | select(.number == $n) | .sha')
  PR_BRANCH=$(echo "$ELIGIBLE" | jq -r --argjson n "$PR_NUMBER" '.[] | select(.number == $n) | .branch')

  # Check merge state
  MERGE_STATE=$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq '.mergeStateStatus')
  echo "Merge state: $MERGE_STATE"

  if [[ "$MERGE_STATE" != "BEHIND" ]]; then
    echo "Already up to date ($MERGE_STATE)"
    SKIPPED=$((SKIPPED + 1))
    echo "::endgroup::"

    # In "next" mode, if the first eligible PR is already current, stop
    if [[ "$INPUT_UPDATE_MODE" == "next" ]]; then
      echo "Mode=next and top PR is current. Done."
      break
    fi
    continue
  fi

  echo "Branch is behind main, updating..."

  # Cancel stale CI runs (they're testing stale code)
  if [[ "$INPUT_CANCEL_STALE_CI" == "true" ]]; then
    echo "Cancelling stale CI runs on $PR_BRANCH..."
    if [[ -n "$INPUT_CI_WORKFLOW" ]]; then
      STALE_RUNS=$(gh run list --branch "$PR_BRANCH" \
        --workflow="$INPUT_CI_WORKFLOW" --status=in_progress --status=queued \
        --json databaseId --jq '.[].databaseId' 2>/dev/null || echo "")
    else
      STALE_RUNS=$(gh run list --branch "$PR_BRANCH" \
        --status=in_progress --status=queued \
        --json databaseId --jq '.[].databaseId' 2>/dev/null || echo "")
    fi

    for RUN_ID in $STALE_RUNS; do
      echo "  Cancelling run $RUN_ID"
      gh run cancel "$RUN_ID" 2>/dev/null || true
    done
  fi

  # Update branch via GitHub API (merge base into PR)
  API_RESPONSE=$(gh api -X PUT "repos/${GH_REPO}/pulls/${PR_NUMBER}/update-branch" \
    --field expected_head_sha="$PR_SHA" \
    --include 2>&1 || echo "FAILED")
  HTTP_CODE=$(printf '%s\n' "$API_RESPONSE" | head -1 | grep -oE '[0-9]{3}' || echo "000")

  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "202" ]]; then
    echo "Branch updated successfully"
    UPDATED=$((UPDATED + 1))

  elif [[ "$HTTP_CODE" == "422" ]]; then
    # Check if it's a merge conflict
    if printf '%s\n' "$API_RESPONSE" | grep -qiE 'merge conflict'; then
      echo "Merge conflict detected"
      CONFLICTS=$((CONFLICTS + 1))

      # Add conflict label
      if [[ -n "$INPUT_CONFLICT_LABEL" ]]; then
        gh pr edit "$PR_NUMBER" --add-label "$INPUT_CONFLICT_LABEL" 2>/dev/null || true
      fi

      # Post conflict comment
      if [[ "$INPUT_CONFLICT_COMMENT" == "true" ]]; then
        gh pr comment "$PR_NUMBER" --body "**Auto-update failed**: This PR has merge conflicts with the base branch. Please resolve them:

\`\`\`bash
git fetch origin
git rebase origin/main
# Resolve conflicts
git push --force-with-lease
\`\`\`" 2>/dev/null || true
      fi
    else
      warn "Update failed for PR #$PR_NUMBER (HTTP 422, not a merge conflict)"
      ERRORS=$((ERRORS + 1))
    fi

  elif [[ "$HTTP_CODE" == "409" ]]; then
    echo "Branch changed during update (SHA mismatch). Will retry on next push."
    SKIPPED=$((SKIPPED + 1))

  else
    warn "Update failed for PR #$PR_NUMBER (HTTP $HTTP_CODE)"
    ERRORS=$((ERRORS + 1))
  fi

  echo "::endgroup::"

  # In "next" mode, only process the first behind PR
  if [[ "$INPUT_UPDATE_MODE" == "next" ]]; then
    echo "Mode=next, processed one PR. Done."
    break
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

SUMMARY="Updated $UPDATED, conflicts $CONFLICTS, skipped $SKIPPED"
if [[ "$ERRORS" -gt 0 ]]; then
  SUMMARY="$SUMMARY, errors $ERRORS"
fi

echo ""
echo "Summary: $SUMMARY"

echo "updated=$UPDATED" >> "$GITHUB_OUTPUT"
echo "conflicts=$CONFLICTS" >> "$GITHUB_OUTPUT"
echo "skipped=$SKIPPED" >> "$GITHUB_OUTPUT"
echo "summary=$SUMMARY" >> "$GITHUB_OUTPUT"

# Set job summary
cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## Auto-Update PR Branches

| Metric | Count |
|--------|-------|
| Updated | $UPDATED |
| Conflicts | $CONFLICTS |
| Skipped (up to date) | $SKIPPED |
| Errors | $ERRORS |
EOF
