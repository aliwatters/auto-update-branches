import { describe, it, expect } from "vitest";
import { filterPRs, transformPRs } from "../src/filter";
import type { ActionInputs, PullRequest } from "../src/types";

const defaultInputs: ActionInputs = {
  token: "test",
  filter: "all",
  label: "automerge",
  updateMode: "all",
  cancelStaleCi: true,
  ciWorkflow: "",
  conflictLabel: "needs-rebase",
  conflictComment: true,
  excludeLabels: ["wip", "do-not-merge"],
  maxUpdates: 0,
  priorityLabels: "",
  configFile: "",
};

const makePR = (
  number: number,
  opts: Partial<PullRequest> = {}
): PullRequest => ({
  number,
  branch: `branch-${number}`,
  sha: `sha-${number}`,
  autoMerge: false,
  labels: [],
  isDraft: false,
  ...opts,
});

describe("transformPRs", () => {
  it("transforms raw GitHub API response", () => {
    const raw = [
      {
        number: 1,
        headRefName: "feature/test",
        headRefOid: "abc123",
        isDraft: false,
        autoMergeRequest: { enabledAt: "2024-01-01" },
        labels: [{ name: "bug" }, { name: "priority:critical" }],
      },
    ];

    const result = transformPRs(raw);
    expect(result).toEqual([
      {
        number: 1,
        branch: "feature/test",
        sha: "abc123",
        autoMerge: true,
        labels: ["bug", "priority:critical"],
        isDraft: false,
      },
    ]);
  });

  it("handles null autoMergeRequest", () => {
    const raw = [
      {
        number: 1,
        headRefName: "fix/test",
        headRefOid: "def456",
        isDraft: true,
        autoMergeRequest: null,
        labels: [],
      },
    ];

    const result = transformPRs(raw);
    expect(result[0].autoMerge).toBe(false);
    expect(result[0].isDraft).toBe(true);
  });
});

describe("filterPRs", () => {
  it("removes draft PRs", () => {
    const prs = [makePR(1), makePR(2, { isDraft: true }), makePR(3)];
    const result = filterPRs(prs, defaultInputs);
    expect(result.map((p) => p.number)).toEqual([1, 3]);
  });

  it("removes PRs with excluded labels", () => {
    const prs = [
      makePR(1, { labels: ["enhancement"] }),
      makePR(2, { labels: ["wip"] }),
      makePR(3, { labels: ["do-not-merge", "bug"] }),
    ];
    const result = filterPRs(prs, defaultInputs);
    expect(result.map((p) => p.number)).toEqual([1]);
  });

  describe("filter modes", () => {
    const prs = [
      makePR(1, { autoMerge: true, labels: ["automerge"] }),
      makePR(2, { autoMerge: true, labels: [] }),
      makePR(3, { autoMerge: false, labels: ["automerge"] }),
      makePR(4, { autoMerge: false, labels: [] }),
    ];

    it("all: returns all non-draft, non-excluded PRs", () => {
      const result = filterPRs(prs, { ...defaultInputs, filter: "all" });
      expect(result.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    });

    it("auto-merge: returns only PRs with auto-merge enabled", () => {
      const result = filterPRs(prs, {
        ...defaultInputs,
        filter: "auto-merge",
      });
      expect(result.map((p) => p.number)).toEqual([1, 2]);
    });

    it("label: returns only PRs with the configured label", () => {
      const result = filterPRs(prs, { ...defaultInputs, filter: "label" });
      expect(result.map((p) => p.number)).toEqual([1, 3]);
    });

    it("auto-merge+label: returns PRs with auto-merge OR the label", () => {
      const result = filterPRs(prs, {
        ...defaultInputs,
        filter: "auto-merge+label",
      });
      expect(result.map((p) => p.number)).toEqual([1, 2, 3]);
    });
  });

  it("handles empty exclude labels", () => {
    const prs = [makePR(1, { labels: ["wip"] })];
    const result = filterPRs(prs, { ...defaultInputs, excludeLabels: [] });
    expect(result).toHaveLength(1);
  });

  it("handles empty PR list", () => {
    expect(filterPRs([], defaultInputs)).toEqual([]);
  });
});
