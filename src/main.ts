import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionInputs } from "./types";
import { transformPRs } from "./filter";
import { filterPRs } from "./filter";
import { buildPriorityMap, prioritizeAndSort } from "./priority";
import { updateBranches, writeSummary } from "./update-branches";

function getInputs(): ActionInputs {
  const excludeStr = core.getInput("exclude-labels");

  return {
    token: core.getInput("token", { required: true }),
    filter: core.getInput("filter") as ActionInputs["filter"],
    label: core.getInput("label"),
    updateMode: core.getInput("update-mode") as ActionInputs["updateMode"],
    cancelStaleCi: core.getBooleanInput("cancel-stale-ci"),
    ciWorkflow: core.getInput("ci-workflow"),
    conflictLabel: core.getInput("conflict-label"),
    conflictComment: core.getBooleanInput("conflict-comment"),
    excludeLabels: excludeStr
      ? excludeStr.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    maxUpdates: parseInt(core.getInput("max-updates"), 10) || 0,
    priorityLabels: core.getInput("priority-labels"),
    configFile: core.getInput("config-file"),
  };
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const octokit = github.getOctokit(inputs.token);
    const { owner, repo } = github.context.repo;

    // Discover open PRs
    core.startGroup("Discovering open PRs");

    const { data: rawPRs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      base: "main",
      per_page: 100,
    });

    const allPRs = transformPRs(
      rawPRs.map((pr) => ({
        number: pr.number,
        headRefName: pr.head.ref,
        headRefOid: pr.head.sha,
        isDraft: pr.draft ?? false,
        autoMergeRequest: pr.auto_merge as { enabledAt: string } | null,
        labels: pr.labels.map((l) => ({ name: l.name ?? "" })),
      }))
    );

    core.info(`Found ${allPRs.length} open PR(s)`);

    // Filter
    const eligible = filterPRs(allPRs, inputs);
    core.info(`After filter (${inputs.filter}): ${eligible.length} eligible PR(s)`);

    if (eligible.length === 0) {
      core.info("No eligible PRs to update.");
      core.setOutput("updated", 0);
      core.setOutput("conflicts", 0);
      core.setOutput("skipped", 0);
      core.setOutput("summary", "No eligible PRs to update");
      core.endGroup();
      return;
    }

    core.endGroup();

    // Prioritize and sort
    core.startGroup("Priority ordering");

    const priorityMap = buildPriorityMap(inputs.priorityLabels, inputs.configFile);
    core.info(`Priority map: ${JSON.stringify(priorityMap)}`);

    const sorted = prioritizeAndSort(eligible, priorityMap);
    core.info("Update order (priority desc):");
    for (const pr of sorted) {
      core.info(`  #${pr.number} priority=${pr.priority} [${pr.branch}]`);
    }

    core.endGroup();

    // Update branches
    const result = await updateBranches(octokit, owner, repo, sorted, inputs);

    // Summary
    writeSummary(result, sorted);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
