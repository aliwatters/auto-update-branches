# What auto-update-branches is for

**auto-update-branches is a GitHub Action that keeps selected open pull-request branches targeting `main` current when `main` advances.**

## Why this document exists

This establishes that the repository delivers a GitHub Action, not a general-purpose merge-queue service or a standalone application. The action reduces the need to manually update eligible PR branches after changes land on `main`, while preserving explicit handling for conflicts and CI work.

## What it does

- `action.yml` declares a Node 20 action whose executable entry point is `dist/index.js` and exposes inputs for filtering, update mode, stale-CI cancellation, conflicts, rate limits, priority labels, and test branches.
- `src/main.ts` obtains open PRs whose base is `main`, removes ineligible PRs through `src/filter.ts`, applies the label priorities from `src/priority.ts`, and dispatches each run by `update-mode`.
- In normal `all` or `next` mode, `src/update-branches.ts` checks GitHub merge state and calls `pulls.updateBranch` for branches that may need updating. It can cancel queued or in-progress workflow runs on those branches and reports `updated`, `conflicts`, `skipped`, and `summary` outputs.
- `src/update-branches.ts` labels and can comment on PRs with merge conflicts instead of attempting their update.
- In `test-branch` mode, `src/test-branch.ts` creates or refreshes branches named `<test-branch-prefix>/pr-<number>`, merges the PR branch there, observes the test branch's workflow state, and posts the corresponding commit status on the PR head.
- `.github/workflows/auto-update-branches.yml` invokes the published `aliwatters/auto-update-branches@v1` action after pushes to `main`, using `next` mode.

## What it is not for

- It does not merge or approve pull requests. Normal processing calls GitHub's branch-update endpoint; test-branch processing only creates a separate merge-test ref and posts a status.
- It does not resolve merge conflicts. `DIRTY` and API-reported conflicts are surfaced through the configured label, optional comment, or a failing merge-test status; the author must resolve the conflict.
- It does not process closed PRs, PRs with a base other than `main`, drafts, or PRs with configured excluded labels. `src/main.ts` requests only open PRs based on `main`, and `src/filter.ts` enforces the other exclusions.
- It is not a persistent service, dashboard, or deployment artifact. The repository defines one Node-based GitHub Action and GitHub Actions workflows rather than a server process or deployment manifest.

## How to tell it is working

- A run discovers open PRs based on `main`, logs the eligible PR count and priority order, and sets the `updated`, `conflicts`, `skipped`, and `summary` action outputs.
- In normal mode, an eligible branch that GitHub reports as behind results in a `pulls.updateBranch` request; an already-current branch increments `skipped` instead.
- A PR with merge conflicts is counted as a conflict and receives the configured `conflict-label` and, when enabled, the explanatory comment.
- With `update-mode: next`, normal processing stops after one definitively handled PR; with `test-branch`, a `merge-test/pr-<number>` branch and its PR-head commit status reflect the merge-test result.

## Where it fits

The action runs inside GitHub Actions, using `@actions/core` and an Octokit client created from the supplied GitHub token. It needs write permissions for PR branch updates; its included dogfooding workflow also grants `actions: write` so stale CI can be cancelled. Priority labels can come from an action input or a checked-out repository configuration file such as `.github/auto-update.yml`; the repository includes an example of that file.
