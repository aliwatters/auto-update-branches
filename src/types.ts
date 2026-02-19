export interface PullRequest {
  number: number;
  branch: string;
  sha: string;
  autoMerge: boolean;
  labels: string[];
  isDraft: boolean;
}

export interface PrioritizedPR extends PullRequest {
  priority: number;
}

export interface ActionInputs {
  token: string;
  filter: "all" | "auto-merge" | "label" | "auto-merge+label";
  label: string;
  updateMode: "all" | "next";
  cancelStaleCi: boolean;
  ciWorkflow: string;
  conflictLabel: string;
  conflictComment: boolean;
  excludeLabels: string[];
  maxUpdates: number;
  priorityLabels: string;
  configFile: string;
}

export interface PriorityMap {
  [label: string]: number;
}

export interface UpdateResult {
  updated: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

export type MergeState =
  | "BEHIND"
  | "CLEAN"
  | "DIRTY"
  | "BLOCKED"
  | "UNKNOWN"
  | "UNSTABLE"
  | "HAS_HOOKS";
