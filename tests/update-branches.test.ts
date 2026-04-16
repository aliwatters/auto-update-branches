import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionInputs, PrioritizedPR, UpdateResult } from "../src/types";

// Mock @actions/core before importing
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

// Import after mocks
import { updateBranches, writeSummary } from "../src/update-branches";
import * as core from "@actions/core";

const defaultInputs: ActionInputs = {
  token: "test",
  filter: "all",
  label: "automerge",
  updateMode: "all",
  cancelStaleCi: true,
  ciWorkflow: "",
  conflictLabel: "needs-rebase",
  conflictComment: true,
  excludeLabels: [],
  maxUpdates: 0,
  priorityLabels: "",
  configFile: "",
};

const makePrioritizedPR = (
  number: number,
  priority: number,
  labels: string[] = []
): PrioritizedPR => ({
  number,
  branch: `branch-${number}`,
  sha: `sha-${number}`,
  autoMerge: false,
  labels,
  isDraft: false,
  priority,
});

describe("writeSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets outputs correctly", () => {
    const result: UpdateResult = {
      updated: 2,
      conflicts: 1,
      skipped: 3,
      errors: 0,
    };
    const prs = [makePrioritizedPR(1, 100), makePrioritizedPR(2, 0)];

    writeSummary(result, prs);

    expect(core.setOutput).toHaveBeenCalledWith("updated", 2);
    expect(core.setOutput).toHaveBeenCalledWith("conflicts", 1);
    expect(core.setOutput).toHaveBeenCalledWith("skipped", 3);
    expect(core.setOutput).toHaveBeenCalledWith(
      "summary",
      "Updated 2, conflicts 1, skipped 3"
    );
  });

  it("includes errors in summary when present", () => {
    const result: UpdateResult = {
      updated: 1,
      conflicts: 0,
      skipped: 0,
      errors: 2,
    };

    writeSummary(result, []);

    expect(core.setOutput).toHaveBeenCalledWith(
      "summary",
      "Updated 1, conflicts 0, skipped 0, errors 2"
    );
  });

  it("includes priority table in job summary when PRs have priority", () => {
    const prs = [
      makePrioritizedPR(1, 100, ["priority:critical"]),
      makePrioritizedPR(2, 0),
    ];
    const result: UpdateResult = {
      updated: 2,
      conflicts: 0,
      skipped: 0,
      errors: 0,
    };

    writeSummary(result, prs);

    const addRawCall = vi.mocked(core.summary.addRaw).mock.calls[0][0];
    expect(addRawCall).toContain("Priority Order");
    expect(addRawCall).toContain("#1");
    expect(addRawCall).toContain("100");
  });

  it("omits priority table when no PRs have priority", () => {
    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0)];
    const result: UpdateResult = {
      updated: 2,
      conflicts: 0,
      skipped: 0,
      errors: 0,
    };

    writeSummary(result, prs);

    const addRawCall = vi.mocked(core.summary.addRaw).mock.calls[0][0];
    expect(addRawCall).not.toContain("Priority Order");
  });
});

describe("updateBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  const makeOctokit = (getMergeStates: string[], updateResult = "updated") => {
    let pullsGetCalls = 0;
    return {
      rest: {
        pulls: {
          get: vi.fn().mockImplementation(() => {
            const state = getMergeStates[pullsGetCalls] ?? getMergeStates[getMergeStates.length - 1];
            pullsGetCalls++;
            return Promise.resolve({ data: { mergeable_state: state } });
          }),
          updateBranch: vi.fn().mockResolvedValue({}),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
        },
        actions: {
          listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          cancelWorkflowRun: vi.fn().mockResolvedValue({}),
        },
      },
    } as any;
  };

  it("skips PR when merge state is CLEAN", async () => {
    const octokit = makeOctokit(["clean"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
  });

  it("updates PR when merge state is BEHIND", async () => {
    const octokit = makeOctokit(["behind"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
  });

  it("retries when merge state is UNKNOWN then resolves to BEHIND", async () => {
    const octokit = makeOctokit(["unknown", "behind"]);
    const prs = [makePrioritizedPR(1, 0)];

    const promise = updateBranches(octokit, "owner", "repo", prs, defaultInputs);
    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("UNKNOWN, retrying")
    );
  });

  it("retries multiple times when merge state stays UNKNOWN", async () => {
    const octokit = makeOctokit(["unknown", "unknown", "unknown", "behind"]);
    const prs = [makePrioritizedPR(1, 0)];

    const promise = updateBranches(octokit, "owner", "repo", prs, defaultInputs);
    // Advance past all retry delays (3s + 6s + 12s)
    await vi.advanceTimersByTimeAsync(25000);

    const result = await promise;

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(4);
  });

  it("attempts update after max retries when state stays UNKNOWN", async () => {
    // All 4 calls return unknown (1 initial + 3 retries)
    // UNKNOWN is ambiguous — may be behind, so we attempt the update
    const octokit = makeOctokit(["unknown", "unknown", "unknown", "unknown"]);
    const prs = [makePrioritizedPR(1, 0)];

    const promise = updateBranches(octokit, "owner", "repo", prs, defaultInputs);
    await vi.advanceTimersByTimeAsync(30000);

    const result = await promise;

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(4);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("still UNKNOWN after 3 retries")
    );
  });

  it("handles DIRTY state as conflict", async () => {
    const octokit = makeOctokit(["dirty"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.conflicts).toBe(1);
    expect(result.updated).toBe(0);
    expect(octokit.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["needs-rebase"] })
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });

  it("attempts update for BLOCKED state (may also be behind)", async () => {
    const octokit = makeOctokit(["blocked"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("BLOCKED (may also be behind)")
    );
  });

  it("attempts update for UNSTABLE state", async () => {
    const octokit = makeOctokit(["unstable"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
  });

  it("attempts update for HAS_HOOKS state", async () => {
    const octokit = makeOctokit(["has_hooks"]);
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
  });

  it("counts up_to_date API response as skipped", async () => {
    // State is BLOCKED (ambiguous) but API says already up to date
    const octokit = makeOctokit(["blocked"]);
    octokit.rest.pulls.updateBranch.mockRejectedValue({
      status: 422,
      message: "merge commit is already up to date",
    });
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("counts conflict from API response separately from DIRTY", async () => {
    // State is BEHIND but API discovers conflict during update
    const octokit = makeOctokit(["behind"]);
    octokit.rest.pulls.updateBranch.mockRejectedValue({
      status: 422,
      message: "Merge conflict",
    });
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.conflicts).toBe(1);
    expect(result.updated).toBe(0);
    expect(octokit.rest.issues.addLabels).toHaveBeenCalled();
  });

  it("handles SHA mismatch gracefully", async () => {
    const octokit = makeOctokit(["behind"]);
    octokit.rest.pulls.updateBranch.mockRejectedValue({
      status: 409,
      message: "Head branch was modified",
    });
    const prs = [makePrioritizedPR(1, 0)];

    const result = await updateBranches(octokit, "owner", "repo", prs, defaultInputs);

    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("stops after first PR in next mode", async () => {
    const octokit = makeOctokit(["behind"]);
    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0)];
    const inputs = { ...defaultInputs, updateMode: "next" as const };

    const result = await updateBranches(octokit, "owner", "repo", prs, inputs);

    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
  });

  it("in next mode, continues to next PR when UNKNOWN state yields up_to_date", async () => {
    // First PR: UNKNOWN after all retries, updateBranch returns "up to date"
    // Second PR: BEHIND, updateBranch succeeds
    // The action should NOT bail after the first PR
    let pullsGetCallCount = 0;
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
            pullsGetCallCount++;
            if (pull_number === 1) {
              return Promise.resolve({ data: { mergeable_state: "unknown" } });
            }
            return Promise.resolve({ data: { mergeable_state: "behind" } });
          }),
          updateBranch: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
            if (pull_number === 1) {
              return Promise.reject({ status: 422, message: "merge commit is already up to date" });
            }
            return Promise.resolve({});
          }),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
        },
        actions: {
          listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          cancelWorkflowRun: vi.fn().mockResolvedValue({}),
        },
      },
    } as any;

    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0)];
    const inputs = { ...defaultInputs, updateMode: "next" as const };

    const promise = updateBranches(octokit, "owner", "repo", prs, inputs);
    // Advance past all retry delays for PR #1 (3s + 6s + 12s)
    await vi.advanceTimersByTimeAsync(30000);

    const result = await promise;

    // PR #1 was skipped (indeterminate), PR #2 was updated
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(1);
    // PR #1: 4 get calls (1 initial + 3 retries) + PR #2: 1 get call = 5
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(5);
    // Both PRs had updateBranch called
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(2);
  });

  it("in next mode, skips up_to_date PR (non-UNKNOWN state) and updates next behind PR", async () => {
    // First PR: BLOCKED state, updateBranch returns "up to date" — no work done
    // Second PR: BEHIND, updateBranch succeeds
    let pullsGetCallCount = 0;
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
            pullsGetCallCount++;
            if (pull_number === 1) {
              return Promise.resolve({ data: { mergeable_state: "blocked" } });
            }
            return Promise.resolve({ data: { mergeable_state: "behind" } });
          }),
          updateBranch: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
            if (pull_number === 1) {
              return Promise.reject({ status: 422, message: "merge commit is already up to date" });
            }
            return Promise.resolve({});
          }),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
        },
        actions: {
          listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          cancelWorkflowRun: vi.fn().mockResolvedValue({}),
        },
      },
    } as any;

    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0)];
    const inputs = { ...defaultInputs, updateMode: "next" as const };

    const result = await updateBranches(octokit, "owner", "repo", prs, inputs);

    // PR #1 skipped (up to date), PR #2 updated
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(1);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(2);
  });

  it("in next mode, skips CLEAN PR and updates next behind PR", async () => {
    // First PR: CLEAN (up to date), should be skipped
    // Second PR: BEHIND, should be updated
    let pullsGetCallCount = 0;
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
            pullsGetCallCount++;
            if (pull_number === 1) {
              return Promise.resolve({ data: { mergeable_state: "clean" } });
            }
            return Promise.resolve({ data: { mergeable_state: "behind" } });
          }),
          updateBranch: vi.fn().mockResolvedValue({}),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
        },
        actions: {
          listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          cancelWorkflowRun: vi.fn().mockResolvedValue({}),
        },
      },
    } as any;

    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0)];
    const inputs = { ...defaultInputs, updateMode: "next" as const };

    const result = await updateBranches(octokit, "owner", "repo", prs, inputs);

    // PR #1 skipped (CLEAN), PR #2 updated
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(1);
    // updateBranch only called for PR #2 (CLEAN skips before API call)
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
  });

  it("in next mode, exits normally when all PRs are up to date", async () => {
    const octokit = makeOctokit(["clean"]);
    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0), makePrioritizedPR(3, 0)];
    const inputs = { ...defaultInputs, updateMode: "next" as const };

    const result = await updateBranches(octokit, "owner", "repo", prs, inputs);

    expect(result.skipped).toBe(3);
    expect(result.updated).toBe(0);
    expect(octokit.rest.pulls.updateBranch).not.toHaveBeenCalled();
  });

  it("respects max-updates limit", async () => {
    const octokit = makeOctokit(["behind"]);
    const prs = [makePrioritizedPR(1, 0), makePrioritizedPR(2, 0), makePrioritizedPR(3, 0)];
    const inputs = { ...defaultInputs, maxUpdates: 2 };

    const result = await updateBranches(octokit, "owner", "repo", prs, inputs);

    expect(result.updated).toBe(2);
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(2);
  });
});
