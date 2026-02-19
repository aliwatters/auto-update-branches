# Auto-Update PR Branches

Automatically update open PR branches when the base branch advances. Prevents auto-merge from stalling when branch protection requires branches to be up-to-date.

**The problem**: You merge a PR. Now every other open PR is "behind main." With strict branch protection, auto-merge stalls until someone manually updates each branch. This action does that automatically.

## Quick Start

```yaml
# .github/workflows/auto-update-branches.yml
name: Auto-Update PR Branches

on:
  push:
    branches: [main]

concurrency:
  group: auto-update-branches
  cancel-in-progress: true

permissions:
  contents: write
  pull-requests: write
  actions: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: aliwatters/auto-update-branches@v1
```

That's it. Every open PR targeting `main` will be updated when `main` advances.

## Configuration

```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    # Which PRs to update: all | auto-merge | label | auto-merge+label
    filter: "all"

    # Label for opt-in filtering
    label: "automerge"

    # Update all eligible PRs, or just the next one to merge
    # "next" mode avoids CI stampede — only one PR runs CI at a time
    update-mode: "all"

    # Cancel in-progress CI on branches being updated (testing stale code)
    cancel-stale-ci: "true"

    # Which workflow to cancel (empty = all)
    ci-workflow: "ci.yml"

    # Label added when a PR has merge conflicts
    conflict-label: "needs-rebase"

    # Post a comment explaining how to resolve conflicts
    conflict-comment: "true"

    # PRs with these labels are never updated (comma-separated)
    exclude-labels: "wip,do-not-merge"

    # Maximum PRs to update per run (0 = unlimited)
    max-updates: "0"
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `token` | `${{ github.token }}` | GitHub token with write permissions |
| `filter` | `all` | Which PRs to update: `all`, `auto-merge`, `label`, `auto-merge+label` |
| `label` | `automerge` | Label name for opt-in filtering |
| `update-mode` | `all` | `all` = update every stale PR, `next` = update only the next to merge |
| `cancel-stale-ci` | `true` | Cancel stale CI runs on updated branches |
| `ci-workflow` | `""` | Workflow filename for CI cancellation (empty = all) |
| `conflict-label` | `needs-rebase` | Label to add on merge conflicts (empty = skip) |
| `conflict-comment` | `true` | Comment on PRs with conflicts |
| `exclude-labels` | `wip,do-not-merge` | Comma-separated labels that exclude PRs |
| `max-updates` | `0` | Max PRs to update per run (0 = unlimited) |
| `priority-labels` | `""` | Label-to-priority mappings (see [Priority Labels](#priority-labels)) |
| `config-file` | `.github/auto-update.yml` | Path to repo config file for label mappings |

## Outputs

| Output | Description |
|--------|-------------|
| `updated` | Number of PRs updated |
| `conflicts` | Number of PRs with merge conflicts |
| `skipped` | Number of PRs already up to date |
| `summary` | Human-readable summary |

## Priority Labels

PRs are updated in priority order — highest priority first. This matters most in `next` mode where only one PR is updated per run: the highest-priority stale PR gets updated and merges first.

### Built-in defaults

| Label | Priority |
|-------|----------|
| `priority:critical` | 100 |
| `priority:high` | 75 |
| `priority:medium` | 50 |
| `priority:low` | 25 |
| *(no priority label)* | 0 |

If a PR has multiple priority labels, the highest weight wins.

### Custom mappings via action input

Map your repo's existing labels directly in the workflow:

```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    priority-labels: "P0=100,P1=75,hotfix=100,bug=60"
```

### Custom mappings via repo config file

For more complex setups, create `.github/auto-update.yml` in your repo:

```yaml
# .github/auto-update.yml
priority-labels:
  P0: 100
  P1: 75
  P2: 50
  P3: 25
  urgent: 100
  hotfix: 100
  bug: 60
  feature: 40
  chore: 20
```

The config file takes precedence over action inputs, which take precedence over built-in defaults. This lets each repo map its own label conventions without changing the workflow file.

> **Note**: Reading the config file requires a checkout step before the action:
> ```yaml
> steps:
>   - uses: actions/checkout@v4
>     with:
>       sparse-checkout: .github/auto-update.yml
>       sparse-checkout-cone-mode: false
>   - uses: aliwatters/auto-update-branches@v1
> ```

## Update Modes

### `all` mode (default)
Updates every eligible PR that is behind the base branch. Simple and correct, but can cause a "CI stampede" — if you have 10 PRs, all 10 get updated and trigger CI simultaneously.

### `next` mode
Updates only the single PR that would merge next (the first eligible PR that is behind). After it merges, the workflow fires again and updates the next one. This creates a sequential merge pipeline with minimal CI waste.

**Recommendation**: Use `next` mode if you have expensive CI or many concurrent PRs. Use `all` if CI is fast and you want everything current.

## Examples

### Simple — update everything
```yaml
- uses: aliwatters/auto-update-branches@v1
```

### Only auto-merge PRs, sequential
```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    filter: "auto-merge"
    update-mode: "next"
```

### Label-based with CI cancellation
```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    filter: "label"
    label: "ready-to-merge"
    cancel-stale-ci: "true"
    ci-workflow: "ci.yml"
```

### Priority-based sequential merge
```yaml
# Update the highest-priority stale PR first
# PRs labeled "P0" or "hotfix" get updated before "P2" or unlabeled PRs
- uses: actions/checkout@v4
  with:
    sparse-checkout: .github/auto-update.yml
    sparse-checkout-cone-mode: false
- uses: aliwatters/auto-update-branches@v1
  with:
    update-mode: "next"
    priority-labels: "P0=100,P1=75,hotfix=100,bug=60"
```

### Rate-limited updates
```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    max-updates: "3"
    cancel-stale-ci: "true"
```

## Roadmap

This action follows a **progressive architecture** — start with zero infrastructure, add capabilities as your team needs them. Each phase is a strict superset of the one before.

### Phase 1: Stateless Action (current)
Pure GitHub Action. No external dependencies. Labels drive priority.

- [x] Smart filtering (all / auto-merge / label / auto-merge+label)
- [x] Stale CI cancellation
- [x] Conflict detection with labeling and comments
- [x] `next` mode for sequential merge pipeline
- [x] Exclude labels and rate limiting
- [x] **Label-based priority ordering** with repo config
- [x] Job summary with priority table

### Phase 2: Label + Free State
GitHub-native state for retry tracking and analytics. Still zero external dependencies — state lives in labels, PR comments, and GitHub Actions artifacts/cache.

- [ ] **Retry tracking via labels**: `auto-update/retry-1`, `auto-update/retry-2`, `auto-update/failed` — backoff on repeated failures, stop updating PRs that always conflict
- [ ] **Analytics via job summary history**: Track update counts, conflict rates, merge latency over time using Actions artifacts
- [ ] **Stale conflict detection**: Auto-remove `needs-rebase` label when conflicts are resolved
- [ ] **Cross-repo summary**: Workflow that aggregates update stats across repos via GitHub API

### Phase 3: Go Sidecar (Optimal)
Optional always-on process for teams that need merge queues, instant webhook response, and full analytics.

- [ ] Single Go binary with embedded SQLite or managed Postgres (`DATABASE_URL` configures both)
- [ ] GitHub App webhook receiver (instant response, not push-triggered polling)
- [ ] Merge queue with priority, batching, and speculative CI checks
- [ ] SQLite + Litestream→S3 for self-hosted durability (~$0.50/mo)
- [ ] Managed Postgres option (DigitalOcean ~$15/mo) for HA, multi-instance, concurrent access
- [ ] Web dashboard for queue visibility and analytics
- [ ] Docker image + Helm chart for easy deployment
- [ ] Backwards compatible: enhances the Action, doesn't replace it

### Why Managed DB? (Phase 3)

SQLite is great for single-instance self-hosted. A managed Postgres ($15/mo on DigitalOcean) unlocks:
- **Multi-instance HA**: Run N sidecar replicas, they all share state
- **Dashboard without sidecar**: Any web app can query the DB directly
- **Cross-repo analytics**: SQL queries across all repos (conflict rates, merge latency, queue depth)
- **Webhook reliability**: Store incoming events in a table, process async, never lose events
- **External integrations**: Slack bots, Grafana, CLI tools all read from the same DB

### Long-term Vision
An open-source, progressively-enhanced alternative to Mergify. Start with zero infrastructure (just the Action), grow into a full merge queue as your team needs it.

```
Phase 1: Action only          → Labels drive priority, zero deps
Phase 2: Action + label state → Retry tracking, analytics, free
Phase 3: Action + Go sidecar  → Merge queue, webhooks, dashboard
```

## How It Works

1. A push to `main` (typically a PR merge) triggers the workflow
2. The action queries all open PRs targeting `main`
3. PRs are filtered by your criteria (auto-merge, labels, exclusions)
4. For each stale PR:
   - Optionally cancels in-progress CI runs (they test stale code)
   - Calls GitHub's [update branch API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch) to merge `main` into the PR
   - On merge conflicts: adds a label and/or posts a comment
5. Outputs a summary to the job log and step summary

## Alternatives

| Tool | Type | State | Cost | Best For |
|------|------|-------|------|----------|
| **This action** | GitHub Action | None (Phase 1) | Free | Simple auto-update, small-medium teams |
| [Mergify](https://mergify.com) | SaaS | Redis + Postgres | Paid per contributor | Enterprise merge queues |
| [Aviator](https://aviator.co) | SaaS | Managed | Free <15 users | Monorepo parallel queues |
| [Bulldozer](https://github.com/palantir/bulldozer) | Self-hosted Go | Stateless | Free | Auto-merge + update, minimal infra |
| GitHub Merge Queue | Native | Managed | Free | Built-in, basic queue |
| [chinthakagodawita/autoupdate](https://github.com/chinthakagodawita/autoupdate) | GitHub Action | None | Free | Simple auto-update |

## License

MIT
