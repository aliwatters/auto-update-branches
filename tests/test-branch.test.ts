import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionInputs, PrioritizedPR } from "../src/types";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  setOutput: vi.fn(),
  summary: {
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn(),
  },
}));

import { processTestBranches, cleanupTestBranches } from "../src/test-branch";

const defaultInputs: ActionInputs = {
  token: "test",
  filter: "all",
  label: "automerge",
  updateMode: "test-branch",
  cancelStaleCi: false,
  ciWorkflow: "",
  conflictLabel: "needs-rebase",
  conflictComment: true,
  excludeLabels: [],
  maxUpdates: 0,
  priorityLabels: "",
  configFile: "",
  testBranchPrefix: "merge-test",
  statusContext: "merge-test",
};

const makePR = (number: number, priority = 0): PrioritizedPR => ({
  number,
  branch: `feature-${number}`,
  sha: `sha-${number}`,
  autoMerge: false,
  labels: [],
  isDraft: false,
  priority,
});

const mainSha = "abc1234567890";

function makeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      git: {
        getRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            return Promise.resolve({ data: { object: { sha: mainSha } } });
          }
          // Test branch doesn't exist by default
          const error = new Error("Not Found") as Error & { status: number };
          error.status = 404;
          return Promise.reject(error);
        }),
        createRef: vi.fn().mockResolvedValue({}),
        updateRef: vi.fn().mockResolvedValue({}),
        deleteRef: vi.fn().mockResolvedValue({}),
        listMatchingRefs: vi.fn().mockResolvedValue({ data: [] }),
        ...(overrides.git as Record<string, unknown> || {}),
      },
      repos: {
        merge: vi.fn().mockResolvedValue({ data: { sha: "merge-sha-123" } }),
        createCommitStatus: vi.fn().mockResolvedValue({}),
        listCommitStatusesForRef: vi.fn().mockResolvedValue({ data: [] }),
        ...(overrides.repos as Record<string, unknown> || {}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({ data: { mergeable_state: "behind" } }),
        updateBranch: vi.fn().mockResolvedValue({}),
        ...(overrides.pulls as Record<string, unknown> || {}),
      },
      issues: {
        addLabels: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        ...(overrides.issues as Record<string, unknown> || {}),
      },
      actions: {
        listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
        cancelWorkflowRun: vi.fn().mockResolvedValue({}),
        ...(overrides.actions as Record<string, unknown> || {}),
      },
    },
  } as any;
}

describe("processTestBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates test branch and posts pending status for a PR", async () => {
    const octokit = makeOctokit();
    const prs = [makePR(42)];

    const result = await processTestBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(1);

    // Should create ref at main SHA
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "refs/heads/merge-test/pr-42",
      sha: mainSha,
    });

    // Should merge PR branch into test branch
    expect(octokit.rest.repos.merge).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      base: "merge-test/pr-42",
      head: "feature-42",
      commit_message: "Merge-test: PR #42 with latest main",
    });

    // Should post pending status
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "sha-42",
        state: "pending",
        context: "merge-test",
      })
    );
  });

  it("skips PR when test branch CI is still running", async () => {
    const octokit = makeOctokit({
      git: {
        getRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            return Promise.resolve({ data: { object: { sha: mainSha } } });
          }
          // Test branch exists
          return Promise.resolve({ data: { object: { sha: "test-branch-sha" } } });
        }),
      },
      actions: {
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
          data: {
            workflow_runs: [{
              status: "in_progress",
              conclusion: null,
            }],
          },
        }),
      },
    });

    const result = await processTestBranches(octokit, "owner", "repo", [makePR(42)], defaultInputs);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    // Should NOT create or update any refs
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
    expect(octokit.rest.git.updateRef).not.toHaveBeenCalled();
  });

  it("posts success status when test branch CI passes", async () => {
    const octokit = makeOctokit({
      git: {
        getRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            return Promise.resolve({ data: { object: { sha: mainSha } } });
          }
          return Promise.resolve({ data: { object: { sha: "test-branch-sha" } } });
        }),
      },
      actions: {
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
          data: {
            workflow_runs: [{
              status: "completed",
              conclusion: "success",
            }],
          },
        }),
      },
    });

    const result = await processTestBranches(octokit, "owner", "repo", [makePR(42)], defaultInputs);

    expect(result.skipped).toBe(1);
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "sha-42",
        state: "success",
        context: "merge-test",
      })
    );
  });

  it("posts failure status when test branch CI fails", async () => {
    const octokit = makeOctokit({
      git: {
        getRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            return Promise.resolve({ data: { object: { sha: mainSha } } });
          }
          return Promise.resolve({ data: { object: { sha: "test-branch-sha" } } });
        }),
      },
      actions: {
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
          data: {
            workflow_runs: [{
              status: "completed",
              conclusion: "failure",
            }],
          },
        }),
      },
    });

    const result = await processTestBranches(octokit, "owner", "repo", [makePR(42)], defaultInputs);

    expect(result.errors).toBe(1);
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "sha-42",
        state: "failure",
        context: "merge-test",
      })
    );
  });

  it("handles merge conflict when creating test branch", async () => {
    const mergeError = new Error("Merge conflict") as Error & { status: number };
    mergeError.status = 409;

    const octokit = makeOctokit({
      repos: {
        merge: vi.fn().mockRejectedValue(mergeError),
        createCommitStatus: vi.fn().mockResolvedValue({}),
        listCommitStatusesForRef: vi.fn().mockResolvedValue({ data: [] }),
      },
    });

    const result = await processTestBranches(octokit, "owner", "repo", [makePR(42)], defaultInputs);

    expect(result.conflicts).toBe(1);
    expect(result.updated).toBe(0);

    // Should post failure status
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "sha-42",
        state: "failure",
        context: "merge-test",
        description: "Merge conflict with main",
      })
    );

    // Should add conflict label
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["needs-rebase"] })
    );
  });

  it("updates existing test branch when main has advanced", async () => {
    const octokit = makeOctokit({
      git: {
        getRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            return Promise.resolve({ data: { object: { sha: mainSha } } });
          }
          // Test branch exists but no CI found (stale)
          return Promise.resolve({ data: { object: { sha: "old-test-sha" } } });
        }),
      },
    });

    const result = await processTestBranches(octokit, "owner", "repo", [makePR(42)], defaultInputs);

    expect(result.updated).toBe(1);

    // Should force-update the existing ref to main SHA first
    expect(octokit.rest.git.updateRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "heads/merge-test/pr-42",
      sha: mainSha,
      force: true,
    });

    // Then merge PR into it
    expect(octokit.rest.repos.merge).toHaveBeenCalled();
  });

  it("processes multiple PRs", async () => {
    const octokit = makeOctokit();
    const prs = [makePR(1), makePR(2), makePR(3)];

    const result = await processTestBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(3);
    expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(3);
    expect(octokit.rest.repos.merge).toHaveBeenCalledTimes(3);
  });
});

describe("cleanupTestBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes test branches for closed PRs", async () => {
    const octokit = makeOctokit({
      git: {
        listMatchingRefs: vi.fn().mockResolvedValue({
          data: [
            { ref: "refs/heads/merge-test/pr-1" },
            { ref: "refs/heads/merge-test/pr-2" },
            { ref: "refs/heads/merge-test/pr-3" },
          ],
        }),
      },
    });

    // Only PRs 1 and 3 are still open
    const openPrs = new Set([1, 3]);

    const cleaned = await cleanupTestBranches(octokit, "owner", "repo", openPrs, "merge-test");

    expect(cleaned).toBe(1);
    expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "heads/merge-test/pr-2",
    });
  });

  it("does nothing when all test branches belong to open PRs", async () => {
    const octokit = makeOctokit({
      git: {
        listMatchingRefs: vi.fn().mockResolvedValue({
          data: [
            { ref: "refs/heads/merge-test/pr-1" },
          ],
        }),
      },
    });

    const cleaned = await cleanupTestBranches(octokit, "owner", "repo", new Set([1]), "merge-test");

    expect(cleaned).toBe(0);
    expect(octokit.rest.git.deleteRef).not.toHaveBeenCalled();
  });
});
