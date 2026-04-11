import * as core from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";
import type { ActionInputs, PrioritizedPR, UpdateResult } from "./types";

type Octokit = InstanceType<typeof GitHub>;

/**
 * Get the SHA of the base branch (main).
 */
async function getBaseBranchSha(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const { data } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: "heads/main",
  });
  return data.object.sha;
}

/**
 * Check if a test branch ref exists and return its SHA if so.
 */
async function getTestBranchSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  testBranch: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${testBranch}`,
    });
    return data.object.sha;
  } catch (error: unknown) {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 404) return null;
    throw error;
  }
}

/**
 * Create a merge commit combining main and the PR branch.
 * Returns the SHA of the merge commit, or null if there's a conflict.
 */
async function createMergeCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  prNumber: number
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseSha,
      tree: [],
    });

    // Use the merge API to create a proper merge
    const { data: mergeData } = await octokit.rest.repos.merge({
      owner,
      repo,
      base: `refs/heads/__merge-test-temp-${prNumber}`,
      head: headSha.substring(0, 7),
    });

    return mergeData.sha;
  } catch {
    return null;
  }
}

/**
 * Create or update a test branch ref.
 */
async function createOrUpdateTestBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  testBranch: string,
  baseSha: string,
  prBranch: string,
  prNumber: number
): Promise<"created" | "conflict" | "error"> {
  try {
    // Use the merge API: merge the PR branch into a test branch based on main.
    // First, create or reset the test branch to point at main's HEAD.
    const existingSha = await getTestBranchSha(octokit, owner, repo, testBranch);

    if (existingSha) {
      // Update existing ref to main HEAD
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${testBranch}`,
        sha: baseSha,
        force: true,
      });
    } else {
      // Create new ref at main HEAD
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${testBranch}`,
        sha: baseSha,
      });
    }

    // Now merge the PR branch into the test branch
    await octokit.rest.repos.merge({
      owner,
      repo,
      base: testBranch,
      head: prBranch,
      commit_message: `Merge-test: PR #${prNumber} with latest main`,
    });

    return "created";
  } catch (error: unknown) {
    const status = (error as { status?: number }).status ?? 0;
    const message = String((error as { message?: string }).message ?? "");

    if (status === 409 || /merge conflict/i.test(message) || /conflict/i.test(message)) {
      // Clean up the test branch on conflict
      await deleteTestBranch(octokit, owner, repo, testBranch);
      return "conflict";
    }

    // Clean up on error too
    try {
      await deleteTestBranch(octokit, owner, repo, testBranch);
    } catch {
      // ignore cleanup errors
    }
    return "error";
  }
}

/**
 * Post a commit status on the PR's head commit.
 */
async function postCommitStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  context: string,
  description: string,
  targetUrl?: string
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context,
    description,
    target_url: targetUrl,
  });
}

/**
 * Delete a test branch ref.
 */
async function deleteTestBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  testBranch: string
): Promise<void> {
  try {
    await octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${testBranch}`,
    });
  } catch (error: unknown) {
    const status = (error as { status?: number }).status ?? 0;
    if (status !== 404 && status !== 422) {
      core.warning(`Failed to delete test branch ${testBranch}: ${error}`);
    }
  }
}

/**
 * Check the current commit status for a given context on a SHA.
 */
async function getCommitStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  context: string
): Promise<"pending" | "success" | "failure" | "error" | null> {
  try {
    const { data } = await octokit.rest.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });

    // Statuses are returned newest first; find the latest for our context
    const status = data.find((s) => s.context === context);
    return status ? (status.state as "pending" | "success" | "failure" | "error") : null;
  } catch {
    return null;
  }
}

/**
 * Check if the test branch's CI has completed by looking at workflow runs.
 */
async function checkTestBranchCI(
  octokit: Octokit,
  owner: string,
  repo: string,
  testBranch: string,
  ciWorkflow: string
): Promise<"success" | "failure" | "pending" | "not_found"> {
  try {
    const params: {
      owner: string;
      repo: string;
      branch: string;
      per_page: number;
      workflow_id?: string;
    } = {
      owner,
      repo,
      branch: testBranch,
      per_page: 5,
    };

    let runs;
    if (ciWorkflow) {
      runs = await octokit.rest.actions.listWorkflowRuns({
        ...params,
        workflow_id: ciWorkflow,
      });
    } else {
      runs = await octokit.rest.actions.listWorkflowRunsForRepo(params);
    }

    if (runs.data.workflow_runs.length === 0) {
      return "not_found";
    }

    const latest = runs.data.workflow_runs[0];
    if (latest.status === "completed") {
      return latest.conclusion === "success" ? "success" : "failure";
    }

    return "pending";
  } catch {
    return "not_found";
  }
}

/**
 * Handle a PR that has merge conflicts in test-branch mode.
 */
async function handleConflict(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prSha: string,
  inputs: ActionInputs
): Promise<void> {
  // Post failure status
  await postCommitStatus(
    octokit, owner, repo, prSha, "failure",
    inputs.statusContext,
    "Merge conflict with main"
  );

  // Add conflict label
  if (inputs.conflictLabel) {
    try {
      await octokit.rest.issues.addLabels({
        owner, repo, issue_number: prNumber,
        labels: [inputs.conflictLabel],
      });
    } catch (error) {
      core.warning(`Failed to add conflict label to PR #${prNumber}: ${error}`);
    }
  }
}

/**
 * Process PRs in test-branch mode.
 *
 * For each eligible PR:
 * 1. Check if a test branch already exists and CI has completed
 * 2. If CI passed, post success status on PR head commit
 * 3. If no test branch or main has advanced, create/update test branch
 * 4. Post pending status on PR head commit
 */
export async function processTestBranches(
  octokit: Octokit,
  owner: string,
  repo: string,
  prs: PrioritizedPR[],
  inputs: ActionInputs
): Promise<UpdateResult> {
  const result: UpdateResult = { updated: 0, conflicts: 0, skipped: 0, errors: 0 };
  const baseSha = await getBaseBranchSha(octokit, owner, repo);

  for (const pr of prs) {
    core.startGroup(`PR #${pr.number} (priority=${pr.priority})`);

    const testBranch = `${inputs.testBranchPrefix}/pr-${pr.number}`;

    // Check if test branch already exists
    const testBranchSha = await getTestBranchSha(octokit, owner, repo, testBranch);

    if (testBranchSha) {
      // Test branch exists — check if CI has completed on it
      const ciStatus = await checkTestBranchCI(
        octokit, owner, repo, testBranch, inputs.ciWorkflow
      );

      if (ciStatus === "success") {
        // CI passed on test branch — post success status on PR
        core.info(`Test branch CI passed — posting success status on PR #${pr.number}`);
        await postCommitStatus(
          octokit, owner, repo, pr.sha, "success",
          inputs.statusContext,
          `Merge test passed (main@${baseSha.substring(0, 7)})`
        );
        result.skipped++;
        core.endGroup();
        continue;
      }

      if (ciStatus === "failure") {
        // CI failed — post failure status, will need investigation
        core.info(`Test branch CI failed — posting failure status on PR #${pr.number}`);
        await postCommitStatus(
          octokit, owner, repo, pr.sha, "failure",
          inputs.statusContext,
          "Merge test failed — CI did not pass on test branch"
        );
        result.errors++;
        core.endGroup();
        continue;
      }

      if (ciStatus === "pending") {
        // CI still running — don't interrupt
        core.info(`Test branch CI still running for PR #${pr.number}, skipping`);
        result.skipped++;
        core.endGroup();
        continue;
      }

      // CI not found — test branch may be stale (main advanced). Recreate it.
      core.info(`Test branch exists but no CI found — recreating for PR #${pr.number}`);
    }

    // Create or update test branch (main + PR)
    core.info(`Creating test branch ${testBranch} for PR #${pr.number}`);

    const outcome = await createOrUpdateTestBranch(
      octokit, owner, repo, testBranch, baseSha, pr.branch, pr.number
    );

    switch (outcome) {
      case "created":
        core.info(`Test branch ${testBranch} created successfully`);
        await postCommitStatus(
          octokit, owner, repo, pr.sha, "pending",
          inputs.statusContext,
          `Merge test in progress (main@${baseSha.substring(0, 7)})`
        );
        result.updated++;
        break;
      case "conflict":
        core.info(`PR #${pr.number} has merge conflicts with main`);
        result.conflicts++;
        await handleConflict(octokit, owner, repo, pr.number, pr.sha, inputs);
        break;
      case "error":
        core.warning(`Failed to create test branch for PR #${pr.number}`);
        result.errors++;
        break;
    }

    core.endGroup();
  }

  return result;
}

/**
 * Clean up test branches for PRs that are no longer open.
 */
export async function cleanupTestBranches(
  octokit: Octokit,
  owner: string,
  repo: string,
  openPrNumbers: Set<number>,
  prefix: string
): Promise<number> {
  let cleaned = 0;

  try {
    // List all refs matching the test branch prefix
    const { data } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `heads/${prefix}/pr-`,
    });

    for (const ref of data) {
      // Extract PR number from ref name (e.g., "merge-test/pr-123")
      const match = ref.ref.match(/\/pr-(\d+)$/);
      if (!match) continue;

      const prNumber = parseInt(match[1], 10);
      if (!openPrNumbers.has(prNumber)) {
        core.info(`Cleaning up stale test branch: ${ref.ref}`);
        await deleteTestBranch(octokit, owner, repo, ref.ref.replace("refs/heads/", ""));
        cleaned++;
      }
    }
  } catch (error) {
    core.warning(`Failed to cleanup test branches: ${error}`);
  }

  return cleaned;
}
