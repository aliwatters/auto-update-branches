import type { ActionInputs, PullRequest } from "./types";

interface RawPR {
  number: number;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  autoMergeRequest: { enabledAt: string } | null;
  labels: { name: string }[];
}

/**
 * Transform raw GitHub API response into our PullRequest type.
 */
export function transformPRs(raw: RawPR[]): PullRequest[] {
  return raw.map((pr) => ({
    number: pr.number,
    branch: pr.headRefName,
    sha: pr.headRefOid,
    autoMerge: pr.autoMergeRequest !== null,
    labels: pr.labels.map((l) => l.name),
    isDraft: pr.isDraft,
  }));
}

/**
 * Filter PRs based on action configuration.
 * Removes drafts, excluded labels, and applies the filter mode.
 */
export function filterPRs(prs: PullRequest[], inputs: ActionInputs): PullRequest[] {
  // Remove drafts
  let filtered = prs.filter((pr) => !pr.isDraft);

  // Remove PRs with excluded labels
  if (inputs.excludeLabels.length > 0) {
    filtered = filtered.filter(
      (pr) => !pr.labels.some((l) => inputs.excludeLabels.includes(l))
    );
  }

  // Apply filter mode
  switch (inputs.filter) {
    case "all":
      return filtered;
    case "auto-merge":
      return filtered.filter((pr) => pr.autoMerge);
    case "label":
      return filtered.filter((pr) => pr.labels.includes(inputs.label));
    case "auto-merge+label":
      return filtered.filter(
        (pr) => pr.autoMerge || pr.labels.includes(inputs.label)
      );
    default:
      return filtered;
  }
}
