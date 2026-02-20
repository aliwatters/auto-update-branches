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

  it("gives up after max retries and skips PR", async () => {
    // All 4 calls return unknown (1 initial + 3 retries)
    const octokit = makeOctokit(["unknown", "unknown", "unknown", "unknown"]);
    const prs = [makePrioritizedPR(1, 0)];

    const promise = updateBranches(octokit, "owner", "repo", prs, defaultInputs);
    await vi.advanceTimersByTimeAsync(30000);

    const result = await promise;

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(4);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("still UNKNOWN after 3 retries")
    );
  });
});
