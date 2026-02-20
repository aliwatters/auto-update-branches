import * as core from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";
import type { ActionInputs, MergeState, PrioritizedPR, UpdateResult } from "./types";

type Octokit = InstanceType<typeof GitHub>;

/**
 * Cancel in-progress and queued CI runs on a branch.
 */
async function cancelStaleRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  ciWorkflow: string
): Promise<number> {
  let cancelled = 0;

  try {
    const params: Parameters<typeof octokit.rest.actions.listWorkflowRunsForRepo>[0] = {
      owner,
      repo,
      branch,
      per_page: 20,
    };

    // If a specific workflow is configured, only cancel runs from that workflow
    if (ciWorkflow) {
      const runs = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: ciWorkflow,
        branch,
        per_page: 20,
      });

      for (const run of runs.data.workflow_runs) {
        if (run.status === "in_progress" || run.status === "queued") {
          await octokit.rest.actions.cancelWorkflowRun({
            owner,
            repo,
            run_id: run.id,
          });
          cancelled++;
        }
      }
    } else {
      const runs = await octokit.rest.actions.listWorkflowRunsForRepo({
        ...params,
      });

      for (const run of runs.data.workflow_runs) {
        if (run.status === "in_progress" || run.status === "queued") {
          await octokit.rest.actions.cancelWorkflowRun({
            owner,
            repo,
            run_id: run.id,
          });
          cancelled++;
        }
      }
    }
  } catch (error) {
    core.warning(`Failed to cancel CI runs on ${branch}: ${error}`);
  }

  return cancelled;
}

/**
 * Handle a PR that has merge conflicts.
 */
async function handleConflict(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  inputs: ActionInputs
): Promise<void> {
  if (inputs.conflictLabel) {
    try {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [inputs.conflictLabel],
      });
    } catch (error) {
      core.warning(`Failed to add conflict label to PR #${prNumber}: ${error}`);
    }
  }

  if (inputs.conflictComment) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `**Auto-update failed**: This PR has merge conflicts with the base branch. Please resolve them:

\`\`\`bash
git fetch origin
git rebase origin/main
# Resolve conflicts
git push --force-with-lease
\`\`\``,
      });
    } catch (error) {
      core.warning(`Failed to comment on PR #${prNumber}: ${error}`);
    }
  }
}

/**
 * Get the merge state of a PR, retrying when UNKNOWN.
 *
 * GitHub computes mergeable_state asynchronously. When the action triggers
 * immediately after a merge to main, the state may be UNKNOWN for several
 * seconds. We retry with exponential backoff to avoid skipping PRs that
 * are actually BEHIND.
 *
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */
async function getMergeState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<MergeState> {
  const maxRetries = 3;
  const baseDelayMs = 3000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // mergeable_state values: "behind", "clean", "dirty", "blocked", "unknown", "unstable", "has_hooks"
    const state = (data.mergeable_state?.toUpperCase() ?? "UNKNOWN") as MergeState;

    if (state !== "UNKNOWN" || attempt === maxRetries) {
      if (state === "UNKNOWN" && attempt === maxRetries) {
        core.warning(`PR #${prNumber}: mergeable_state still UNKNOWN after ${maxRetries} retries`);
      }
      return state;
    }

    const delayMs = baseDelayMs * Math.pow(2, attempt);
    core.info(`PR #${prNumber}: mergeable_state is UNKNOWN, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return "UNKNOWN";
}

/**
 * Update a single PR branch by merging the base branch into it.
 */
async function updatePRBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  expectedSha: string
): Promise<"updated" | "conflict" | "sha_mismatch" | "error"> {
  try {
    await octokit.rest.pulls.updateBranch({
      owner,
      repo,
      pull_number: prNumber,
      expected_head_sha: expectedSha,
    });
    return "updated";
  } catch (error: unknown) {
    const status = (error as { status?: number }).status ?? 0;

    if (status === 422) {
      const message = String((error as { message?: string }).message ?? "");
      if (/merge conflict/i.test(message)) {
        return "conflict";
      }
      return "error";
    }

    if (status === 409) {
      return "sha_mismatch";
    }

    return "error";
  }
}

/**
 * Process all eligible PRs: check merge state, cancel stale CI, update branch.
 */
export async function updateBranches(
  octokit: Octokit,
  owner: string,
  repo: string,
  prs: PrioritizedPR[],
  inputs: ActionInputs
): Promise<UpdateResult> {
  const result: UpdateResult = { updated: 0, conflicts: 0, skipped: 0, errors: 0 };
  const max = inputs.maxUpdates;

  for (const pr of prs) {
    if (max > 0 && result.updated >= max) {
      core.info(`Reached max-updates limit (${max}). Stopping.`);
      break;
    }

    core.startGroup(`PR #${pr.number} (priority=${pr.priority})`);

    const mergeState = await getMergeState(octokit, owner, repo, pr.number);
    core.info(`Merge state: ${mergeState}`);

    if (mergeState !== "BEHIND") {
      core.info(`Already up to date (${mergeState})`);
      result.skipped++;
      core.endGroup();

      if (inputs.updateMode === "next") {
        core.info("Mode=next and top PR is current. Done.");
        break;
      }
      continue;
    }

    core.info("Branch is behind, updating...");

    // Cancel stale CI
    if (inputs.cancelStaleCi) {
      const cancelled = await cancelStaleRuns(
        octokit,
        owner,
        repo,
        pr.branch,
        inputs.ciWorkflow
      );
      if (cancelled > 0) {
        core.info(`Cancelled ${cancelled} stale CI run(s)`);
      }
    }

    // Update the branch
    const outcome = await updatePRBranch(octokit, owner, repo, pr.number, pr.sha);

    switch (outcome) {
      case "updated":
        core.info("Branch updated successfully");
        result.updated++;
        break;
      case "conflict":
        core.info("Merge conflict detected");
        result.conflicts++;
        await handleConflict(octokit, owner, repo, pr.number, inputs);
        break;
      case "sha_mismatch":
        core.info("Branch changed during update (SHA mismatch). Will retry on next push.");
        result.skipped++;
        break;
      case "error":
        core.warning(`Update failed for PR #${pr.number}`);
        result.errors++;
        break;
    }

    core.endGroup();

    if (inputs.updateMode === "next") {
      core.info("Mode=next, processed one PR. Done.");
      break;
    }
  }

  return result;
}

/**
 * Write GitHub Actions outputs and job summary.
 */
export function writeSummary(result: UpdateResult, prs: PrioritizedPR[]): void {
  const summary = `Updated ${result.updated}, conflicts ${result.conflicts}, skipped ${result.skipped}${result.errors > 0 ? `, errors ${result.errors}` : ""}`;

  core.setOutput("updated", result.updated);
  core.setOutput("conflicts", result.conflicts);
  core.setOutput("skipped", result.skipped);
  core.setOutput("summary", summary);

  core.info(`\nSummary: ${summary}`);

  // Job summary
  let md = `## Auto-Update PR Branches\n\n`;
  md += `| Metric | Count |\n|--------|-------|\n`;
  md += `| Updated | ${result.updated} |\n`;
  md += `| Conflicts | ${result.conflicts} |\n`;
  md += `| Skipped (up to date) | ${result.skipped} |\n`;
  md += `| Errors | ${result.errors} |\n`;

  const hasPriority = prs.some((pr) => pr.priority > 0);
  if (hasPriority) {
    md += `\n### Priority Order\n\n`;
    md += `| PR | Priority | Branch |\n|----|----------|--------|\n`;
    for (const pr of prs) {
      md += `| #${pr.number} | ${pr.priority} | \`${pr.branch}\` |\n`;
    }
  }

  core.summary.addRaw(md).write();
}
