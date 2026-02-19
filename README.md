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

## Outputs

| Output | Description |
|--------|-------------|
| `updated` | Number of PRs updated |
| `conflicts` | Number of PRs with merge conflicts |
| `skipped` | Number of PRs already up to date |
| `summary` | Human-readable summary |

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

### Rate-limited updates
```yaml
- uses: aliwatters/auto-update-branches@v1
  with:
    max-updates: "3"
    cancel-stale-ci: "true"
```

## Roadmap

This action follows a progressive architecture — start simple, add capabilities as needed.

### Phase 1: Stateless Action (current)
Pure GitHub Action. No external dependencies. Reacts to `push` events, updates branches via GitHub API. Covers 80% of use cases.

- [x] Smart filtering (all / auto-merge / label / auto-merge+label)
- [x] Stale CI cancellation
- [x] Conflict detection with labeling and comments
- [x] `next` mode for sequential merge pipeline
- [x] Exclude labels
- [x] Rate limiting via `max-updates`
- [x] Job summary output

### Phase 2: Free State Management
GitHub-native state storage for ordering and analytics. Zero external dependencies.

- [ ] **Gist-based state**: Store queue state in a private gist (free, API-accessible, no repo pollution)
- [ ] Priority queue ordering (labels or config-based)
- [ ] Retry tracking with backoff (don't keep updating a PR that always conflicts)
- [ ] Update history / analytics via gist
- [ ] Cross-repo coordination (single gist tracks multiple repos)

### Phase 3: Go Sidecar (Optimal)
Optional always-on process for teams that need merge queues, instant webhook response, and full analytics.

- [ ] Single Go binary with embedded SQLite
- [ ] GitHub App webhook receiver (instant, not polling)
- [ ] Merge queue with priority, batching, and speculative checks
- [ ] Litestream replication to S3 for durability (~$0.50/mo)
- [ ] Web dashboard for queue visibility
- [ ] Docker image + Helm chart for easy deployment
- [ ] Backwards compatible: works alongside the Action, enhances it

### Long-term Vision
An open-source, progressively-enhanced alternative to Mergify. Start with zero infrastructure (just the Action), grow into a full merge queue as your team needs it.

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
