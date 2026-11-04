import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const workflowPath = ".github/workflows/dependency-verification.yml";
const allowedFiles = new Set(["package.json", "package-lock.json", "renovate.json"]);

export function assertDependencyPR(pr, repository, sha) {
  if (
    pr.user?.login !== "renovate[bot]" ||
    pr.user?.type !== "Bot" ||
    pr.state !== "open" ||
    pr.base?.repo?.full_name !== repository ||
    pr.head?.repo?.full_name !== repository ||
    !pr.head?.ref ||
    pr.head?.sha !== sha
  ) {
    throw new Error("Expected an open, same-repository Renovate PR at the triggering head SHA");
  }
}

export function assertDependencyFiles(files, expectedCount) {
  if (
    !Number.isInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > allowedFiles.size ||
    files.length !== expectedCount ||
    !files.every(
      (file) =>
        allowedFiles.has(file.filename) &&
        (file.status !== "renamed" || allowedFiles.has(file.previous_filename)) &&
        (file.previous_filename === undefined || allowedFiles.has(file.previous_filename)),
    )
  ) {
    throw new Error(
      "Renovate verification permits only package.json, package-lock.json and renovate.json (complete file list required)",
    );
  }
}

export function verificationState(runs, { sha, repository, headRef, workflowId }) {
  const latest = runs
    .filter(
      (run) =>
        run.workflow_id === workflowId &&
        run.path?.split("@", 1)[0] === workflowPath &&
        run.event === "pull_request" &&
        run.head_sha === sha &&
        run.head_repository?.full_name === repository &&
        run.head_branch === headRef,
    )
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed") return "pending";
  return latest.conclusion === "success" ? "passed" : "failed";
}

// The workflow runs this file from the PR's trusted base checkout, never its head.
export async function verifyDependencyPR({ api, repository, prNumber, sha, sleep = setTimeout, attempts = 180 }) {
  const prPath = `repos/${repository}/pulls/${prNumber}`;
  const pr = await api(prPath);
  assertDependencyPR(pr, repository, sha);
  const files = [];
  const batch = await api(`${prPath}/files?per_page=100&page=1`);
  files.push(...batch);
  assertDependencyFiles(files, pr.changed_files);

  const workflow = await api(`repos/${repository}/actions/workflows/dependency-verification.yml`);
  if (workflow.path !== workflowPath || !Number.isInteger(workflow.id) || workflow.state !== "active") {
    throw new Error("Dependency verification workflow is missing or inactive");
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = [];
    for (let page = 1; ; page++) {
      const result = await api(
        `repos/${repository}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${sha}&per_page=100&page=${page}`,
      );
      runs.push(...result.workflow_runs);
      if (result.workflow_runs.length < 100) break;
    }
    const state = verificationState(runs, {
      sha,
      repository,
      headRef: pr.head.ref,
      workflowId: workflow.id,
    });
    if (state === "failed") throw new Error(`Dependency verification failed for ${sha}`);
    if (state === "passed") {
      // A split/rebase invalidates the old run even if it passed while we waited.
      assertDependencyPR(await api(prPath), repository, sha);
      return;
    }
    if (attempt + 1 < attempts) await sleep(15000);
  }
  throw new Error(`Timed out waiting for dependency verification at ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    await verifyDependencyPR({
      repository: process.env.GITHUB_REPOSITORY,
      prNumber: event.pull_request.number,
      sha: event.pull_request.head.sha,
      api: async (path) => {
        const response = await globalThis.fetch(`${process.env.GITHUB_API_URL}/${path}`, {
          headers: {
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: globalThis.AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
        return response.json();
      },
    });
    process.stdout.write("Renovate dependency verification passed on this exact head SHA.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
