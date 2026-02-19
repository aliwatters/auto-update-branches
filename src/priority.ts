import * as fs from "fs";
import * as yaml from "js-yaml";
import type { PriorityMap, PrioritizedPR, PullRequest } from "./types";

const BUILT_IN_PRIORITIES: PriorityMap = {
  "priority:critical": 100,
  "priority:high": 75,
  "priority:medium": 50,
  "priority:low": 25,
};

/**
 * Parse "label=weight,label=weight" string into a PriorityMap.
 */
export function parsePriorityInput(input: string): PriorityMap {
  const map: PriorityMap = {};
  if (!input.trim()) return map;

  for (const pair of input.split(",")) {
    const trimmed = pair.trim();
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const label = trimmed.slice(0, eqIndex).trim();
    const weight = parseInt(trimmed.slice(eqIndex + 1).trim(), 10);

    if (label && !isNaN(weight)) {
      map[label] = weight;
    }
  }
  return map;
}

/**
 * Load priority-labels from a YAML config file.
 * Returns empty map if file doesn't exist or is invalid.
 */
export function loadConfigFile(path: string): PriorityMap {
  try {
    if (!fs.existsSync(path)) return {};

    const content = fs.readFileSync(path, "utf-8");
    const config = yaml.load(content) as Record<string, unknown> | null;

    if (!config || typeof config !== "object") return {};

    const labels = config["priority-labels"];
    if (!labels || typeof labels !== "object") return {};

    const map: PriorityMap = {};
    for (const [key, value] of Object.entries(
      labels as Record<string, unknown>
    )) {
      if (typeof value === "number") {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Build the final priority map from all sources.
 * Precedence: config file > action input > built-in defaults.
 */
export function buildPriorityMap(
  inputStr: string,
  configPath: string
): PriorityMap {
  const input = parsePriorityInput(inputStr);
  const config = loadConfigFile(configPath);

  return {
    ...BUILT_IN_PRIORITIES,
    ...input,
    ...config,
  };
}

/**
 * Calculate priority for a PR based on its labels.
 * Returns the highest matching priority weight (0 if no matches).
 */
export function calcPriority(labels: string[], map: PriorityMap): number {
  let max = 0;
  for (const label of labels) {
    const weight = map[label];
    if (weight !== undefined && weight > max) {
      max = weight;
    }
  }
  return max;
}

/**
 * Add priority weights to PRs and sort by priority descending, then PR number ascending.
 */
export function prioritizeAndSort(
  prs: PullRequest[],
  map: PriorityMap
): PrioritizedPR[] {
  const prioritized = prs.map((pr) => ({
    ...pr,
    priority: calcPriority(pr.labels, map),
  }));

  return prioritized.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.number - b.number;
  });
}
