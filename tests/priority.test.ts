import { describe, it, expect } from "vitest";
import {
  parsePriorityInput,
  loadConfigFile,
  buildPriorityMap,
  calcPriority,
  prioritizeAndSort,
} from "../src/priority";
import type { PullRequest } from "../src/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parsePriorityInput", () => {
  it("parses comma-separated label=weight pairs", () => {
    expect(parsePriorityInput("P0=100,P1=75")).toEqual({ P0: 100, P1: 75 });
  });

  it("trims whitespace", () => {
    expect(parsePriorityInput(" urgent = 200 , hotfix = 150 ")).toEqual({
      urgent: 200,
      hotfix: 150,
    });
  });

  it("returns empty map for empty string", () => {
    expect(parsePriorityInput("")).toEqual({});
    expect(parsePriorityInput("  ")).toEqual({});
  });

  it("skips malformed entries", () => {
    expect(parsePriorityInput("P0=100,bad,P1=75")).toEqual({
      P0: 100,
      P1: 75,
    });
  });

  it("skips entries with non-numeric weights", () => {
    expect(parsePriorityInput("P0=abc,P1=75")).toEqual({ P1: 75 });
  });

  it("handles labels with colons", () => {
    expect(parsePriorityInput("priority:critical=100")).toEqual({
      "priority:critical": 100,
    });
  });
});

describe("loadConfigFile", () => {
  it("loads priority-labels from a YAML file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(
      configPath,
      `priority-labels:\n  P0: 100\n  hotfix: 200\n`
    );

    expect(loadConfigFile(configPath)).toEqual({ P0: 100, hotfix: 200 });

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty map for missing file", () => {
    expect(loadConfigFile("/nonexistent/file.yml")).toEqual({});
  });

  it("returns empty map for invalid YAML", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(configPath, "not: [valid: yaml: {{}");

    expect(loadConfigFile(configPath)).toEqual({});

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty map for YAML without priority-labels key", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(configPath, "other-key: value\n");

    expect(loadConfigFile(configPath)).toEqual({});

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("ignores non-numeric values in config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(
      configPath,
      `priority-labels:\n  P0: 100\n  bad: "string"\n`
    );

    expect(loadConfigFile(configPath)).toEqual({ P0: 100 });

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("buildPriorityMap", () => {
  it("includes built-in defaults", () => {
    const map = buildPriorityMap("", "/nonexistent");
    expect(map["priority:critical"]).toBe(100);
    expect(map["priority:high"]).toBe(75);
    expect(map["priority:medium"]).toBe(50);
    expect(map["priority:low"]).toBe(25);
  });

  it("input overrides built-in defaults", () => {
    const map = buildPriorityMap("priority:critical=200", "/nonexistent");
    expect(map["priority:critical"]).toBe(200);
    expect(map["priority:high"]).toBe(75); // unchanged
  });

  it("config file overrides input", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(
      configPath,
      `priority-labels:\n  priority:critical: 300\n`
    );

    const map = buildPriorityMap("priority:critical=200", configPath);
    expect(map["priority:critical"]).toBe(300); // config wins

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("merges all sources", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aub-test-"));
    const configPath = path.join(tmpDir, "auto-update.yml");
    fs.writeFileSync(configPath, `priority-labels:\n  P0: 100\n`);

    const map = buildPriorityMap("urgent=200", configPath);

    // Built-in
    expect(map["priority:critical"]).toBe(100);
    // Input
    expect(map["urgent"]).toBe(200);
    // Config
    expect(map["P0"]).toBe(100);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("calcPriority", () => {
  const map = { "priority:critical": 100, "priority:high": 75, bug: 60 };

  it("returns highest matching weight", () => {
    expect(calcPriority(["bug", "priority:critical"], map)).toBe(100);
  });

  it("returns 0 for no matching labels", () => {
    expect(calcPriority(["enhancement", "feature"], map)).toBe(0);
  });

  it("returns 0 for empty labels", () => {
    expect(calcPriority([], map)).toBe(0);
  });

  it("returns single match weight", () => {
    expect(calcPriority(["bug"], map)).toBe(60);
  });
});

describe("prioritizeAndSort", () => {
  const map = { "priority:critical": 100, "priority:high": 75 };

  const makePR = (number: number, labels: string[]): PullRequest => ({
    number,
    branch: `branch-${number}`,
    sha: `sha-${number}`,
    autoMerge: false,
    labels,
    isDraft: false,
  });

  it("sorts by priority descending", () => {
    const prs = [
      makePR(1, []),
      makePR(2, ["priority:critical"]),
      makePR(3, ["priority:high"]),
    ];

    const sorted = prioritizeAndSort(prs, map);
    expect(sorted.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("breaks ties by PR number ascending", () => {
    const prs = [makePR(5, []), makePR(3, []), makePR(1, [])];

    const sorted = prioritizeAndSort(prs, map);
    expect(sorted.map((p) => p.number)).toEqual([1, 3, 5]);
  });

  it("attaches priority weights", () => {
    const prs = [makePR(1, ["priority:critical"]), makePR(2, [])];

    const sorted = prioritizeAndSort(prs, map);
    expect(sorted[0].priority).toBe(100);
    expect(sorted[1].priority).toBe(0);
  });

  it("handles empty PR list", () => {
    expect(prioritizeAndSort([], map)).toEqual([]);
  });
});
