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
import { writeSummary } from "../src/update-branches";
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
