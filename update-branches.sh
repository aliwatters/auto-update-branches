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
# Priority label mapping
# ---------------------------------------------------------------------------

# Build a JSON object mapping label names to priority weights.
# Sources (in order of precedence):
#   1. Repo config file (.github/auto-update.yml)
#   2. Action input (priority-labels)
#   3. Built-in defaults
build_priority_map() {
  local map='{}'

  # Built-in defaults
  map=$(echo "$map" | jq '. + {
    "priority:critical": 100,
    "priority:high": 75,
    "priority:medium": 50,
    "priority:low": 25
  }')

  # Parse action input: "urgent=200,hotfix=150"
  if [[ -n "${INPUT_PRIORITY_LABELS:-}" ]]; then
    IFS=',' read -ra PAIRS <<< "$INPUT_PRIORITY_LABELS"
    for pair in "${PAIRS[@]}"; do
      pair=$(echo "$pair" | xargs)
      label="${pair%%=*}"
      weight="${pair##*=}"
      if [[ -n "$label" && -n "$weight" ]]; then
        map=$(echo "$map" | jq --arg l "$label" --argjson w "$weight" '. + {($l): $w}')
      fi
    done
  fi

  # Parse repo config file (highest precedence)
  if [[ -f "${INPUT_CONFIG_FILE:-}" ]]; then
    echo "Loading config from ${INPUT_CONFIG_FILE}"
    # Extract priority-labels section from YAML config
    # Supports format:
    #   priority-labels:
    #     critical: 100
    #     high: 75
    #     P0: 100
    if command -v python3 &>/dev/null; then
      CONFIG_PRIORITIES=$(python3 -c "
import yaml, json, sys
try:
    with open('${INPUT_CONFIG_FILE}') as f:
        config = yaml.safe_load(f) or {}
    labels = config.get('priority-labels', {})
    if isinstance(labels, dict):
        print(json.dumps(labels))
    else:
        print('{}')
except Exception:
    print('{}')
" 2>/dev/null || echo '{}')
      if [[ "$CONFIG_PRIORITIES" != '{}' ]]; then
        map=$(echo "$map" "$CONFIG_PRIORITIES" | jq -s '.[0] * .[1]')
        echo "Config overrides: $CONFIG_PRIORITIES"
      fi
    fi
  fi

  echo "$map"
}

# Calculate priority weight for a PR based on its labels
# Args: $1 = JSON array of label names, $2 = priority map JSON
calc_priority() {
  local labels="$1"
  local priority_map="$2"
  echo "$labels" "$priority_map" | jq -s '
    .[1] as $map |
    [.[0][] | . as $label | $map[$label] // 0] |
    max // 0
  '
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
  {
    echo "updated=0"
    echo "conflicts=0"
    echo "skipped=0"
    echo "summary=No eligible PRs to update"
  } >> "$GITHUB_OUTPUT"
  echo "::endgroup::"
  exit 0
fi

echo "::endgroup::"

# ---------------------------------------------------------------------------
# Priority sorting
# ---------------------------------------------------------------------------

echo "::group::Priority ordering"

PRIORITY_MAP=$(build_priority_map)
echo "Priority map: $PRIORITY_MAP"

# Add priority weight to each PR and sort descending (highest priority first)
ELIGIBLE=$(echo "$ELIGIBLE" | jq --argjson pmap "$PRIORITY_MAP" '
  [.[] | . + {
    priority: ([.labels[] | . as $l | $pmap[$l] // 0] | max // 0)
  }] | sort_by(-.priority, .number)
')

echo "Update order (priority desc):"
echo "$ELIGIBLE" | jq -r '.[] | "  #\(.number) priority=\(.priority) [\(.branch)]"'

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

{
  echo "updated=$UPDATED"
  echo "conflicts=$CONFLICTS"
  echo "skipped=$SKIPPED"
  echo "summary=$SUMMARY"
} >> "$GITHUB_OUTPUT"

# Set job summary
{
  echo "## Auto-Update PR Branches"
  echo ""
  echo "| Metric | Count |"
  echo "|--------|-------|"
  echo "| Updated | $UPDATED |"
  echo "| Conflicts | $CONFLICTS |"
  echo "| Skipped (up to date) | $SKIPPED |"
  echo "| Errors | $ERRORS |"

  # Show priority ordering if any PRs had non-zero priority
  HAS_PRIORITY=$(echo "$ELIGIBLE" | jq '[.[] | select(.priority > 0)] | length')
  if [[ "$HAS_PRIORITY" -gt 0 ]]; then
    echo ""
    echo "### Priority Order"
    echo ""
    echo "| PR | Priority | Branch |"
    echo "|----|----------|--------|"
    echo "$ELIGIBLE" | jq -r '.[] | "| #\(.number) | \(.priority) | `\(.branch)` |"'
  fi
} >> "$GITHUB_STEP_SUMMARY"
