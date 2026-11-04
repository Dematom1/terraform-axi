import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  assertDependencyFiles,
  assertDependencyPR,
  verificationState,
  verifyDependencyPR,
} from "../scripts/verify-dependency-pr.mjs";

const repository = "Dematom1/terraform-axi";
const sha = "a".repeat(40);
const prNumber = 123;
const workflowId = 456;
const headRef = "renovate/weekly-non-major";
const context = { repository, sha, headRef, workflowId };
const pr = {
  user: { login: "renovate[bot]", type: "Bot" },
  state: "open",
  base: { repo: { full_name: repository } },
  head: { sha, ref: headRef, repo: { full_name: repository } },
  changed_files: 2,
};
const files = [{ filename: "package.json" }, { filename: "package-lock.json" }];
const run = {
  id: 1,
  workflow_id: workflowId,
  path: ".github/workflows/dependency-verification.yml",
  head_sha: sha,
  head_branch: headRef,
  head_repository: { full_name: repository },
  event: "pull_request",
  // GitHub can return an empty list even for a pull_request run.
  pull_requests: [],
  status: "completed",
  conclusion: "success",
};

function fixtureAPI({ pull = pr, changed = files, runs = [run] } = {}) {
  return async (path) => {
    if (path === `repos/${repository}/pulls/${prNumber}`) return pull;
    if (path.includes("/files?")) {
      const page = Number(new globalThis.URLSearchParams(path.split("?")[1]).get("page"));
      return changed.slice((page - 1) * 100, page * 100);
    }
    if (path.includes("/runs?")) {
      const page = Number(new globalThis.URLSearchParams(path.split("?")[1]).get("page"));
      return { workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    if (path.endsWith("/actions/workflows/dependency-verification.yml")) {
      return { id: workflowId, path: run.path, state: "active" };
    }
    throw new Error(`Unexpected API request: ${path}`);
  };
}

// Exercise the same entry point the required workflow runs, with local API fixtures.
const verify = (api, options = {}) =>
  verifyDependencyPR({ api, repository, sha, prNumber, sleep: async () => {}, attempts: 2, ...options });

describe("Renovate dependency file boundary", () => {
  it("accepts all three dependency files", () => {
    expect(() => assertDependencyFiles([...files, { filename: "renovate.json" }], 3)).not.toThrow();
    expect(() => assertDependencyPR(pr, repository, sha)).not.toThrow();
  });

  it.each([
    [[{ filename: "src/cli.ts" }], 1],
    [[...files, { filename: ".github/workflows/ci.yml" }], 3],
    [[{ filename: "package.json", status: "renamed", previous_filename: "src/cli.ts" }], 1],
    [[{ filename: "package.json", status: "renamed" }], 1],
    [[{ filename: "../package.json" }], 1],
    [[{ filename: "package.json.bak" }], 1],
    [[], 0],
    [files, 3],
    [files, undefined],
    [files, 3001],
  ])("rejects forbidden files, renames and incomplete lists: %j", (changed, count) => {
    expect(() => assertDependencyFiles(changed, count)).toThrow();
  });

  it.each([
    { user: { login: "someone", type: "User" } },
    { user: { login: "renovate[bot]", type: "User" } },
    { state: "closed" },
    { head: { sha: "b".repeat(40), repo: { full_name: repository } } },
    { head: { sha, repo: { full_name: "attacker/terraform-axi" } } },
    { base: { repo: { full_name: "attacker/terraform-axi" } } },
  ])("rejects changed SHA, forks and non-Renovate authors: %j", (override) => {
    expect(() => assertDependencyPR({ ...pr, ...override }, repository, sha)).toThrow();
  });
});

describe("same-head workflow verification", () => {
  it("accepts only the exact workflow on this PR SHA", async () => {
    expect(verificationState([run], context)).toBe("passed");
    await expect(verify(fixtureAPI())).resolves.toBeUndefined();
  });

  it.each([headRef, sha, "refs/pull/123/merge"])("accepts GitHub's ref-suffixed run path: %s", async (ref) => {
    const suffixed = { ...run, path: `${run.path}@${ref}` };
    expect(verificationState([suffixed], context)).toBe("passed");
    await expect(verify(fixtureAPI({ runs: [suffixed] }))).resolves.toBeUndefined();
  });

  it.each([
    { head_sha: "b".repeat(40) },
    { event: "push" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/ci.yml" },
    { path: ".github/workflows/ci.yml@main" },
    { workflow_id: 999 },
    { head_repository: { full_name: "attacker/terraform-axi" } },
    { head_branch: "unrelated-branch" },
    { head_branch: undefined },
  ])("never accepts an unrelated run: %j", async (override) => {
    const runs = [{ ...run, ...override }];
    expect(verificationState(runs, context)).toBe("pending");
    await expect(verify(fixtureAPI({ runs }))).rejects.toThrow("Timed out");
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", null])(
    "rejects completed %s results",
    async (conclusion) => {
      await expect(verify(fixtureAPI({ runs: [{ ...run, conclusion }] }))).rejects.toThrow("failed");
    },
  );

  it("does not reuse an earlier successful run over a newer failing or pending run", async () => {
    const older = { ...run, id: 1 };
    const newerFailed = { ...run, id: 200, conclusion: "failure" };
    const laterPageRuns = [...Array.from({ length: 100 }, (_, id) => ({ ...run, id: id + 10 })), newerFailed];
    await expect(verify(fixtureAPI({ runs: [older, ...laterPageRuns] }))).rejects.toThrow("failed");

    const newerPending = { ...run, id: 200, status: "in_progress", conclusion: null };
    expect(verificationState([older, newerPending], context)).toBe("pending");
    await expect(verify(fixtureAPI({ runs: [older, ...laterPageRuns.slice(0, 100), newerPending] }))).rejects.toThrow(
      "Timed out",
    );
  });

  it("checks beyond 30 full pages before accepting an older success", async () => {
    const runs = [
      ...Array.from({ length: 3000 }, (_, id) => ({ ...run, id: id + 1 })),
      {
        ...run,
        id: 4000,
        conclusion: "failure",
      },
    ];
    await expect(verify(fixtureAPI({ runs }))).rejects.toThrow("failed");
  });

  it("waits for an in-flight verification to complete", async () => {
    let completed = false;
    const baseAPI = fixtureAPI();
    await expect(
      verify(
        async (path) => {
          if (path.includes("/runs?")) {
            return { workflow_runs: [{ ...run, status: completed ? "completed" : "in_progress" }] };
          }
          return baseAPI(path);
        },
        {
          sleep: async () => {
            completed = true;
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a SHA change while verification completes", async () => {
    let reads = 0;
    const api = fixtureAPI();
    await expect(
      verify(async (path) => {
        if (path === `repos/${repository}/pulls/${prNumber}` && reads++ > 0) {
          return { ...pr, head: { ...pr.head, sha: "b".repeat(40) } };
        }
        return api(path);
      }),
    ).rejects.toThrow("triggering head SHA");
  });

  it("rejects incomplete or oversized dependency-file lists", async () => {
    const changed = Array.from({ length: 100 }, () => ({ filename: "package.json" }));
    changed.push({ filename: "src/cli.ts" });
    await expect(verify(fixtureAPI({ pull: { ...pr, changed_files: changed.length }, changed }))).rejects.toThrow(
      "only package.json",
    );
  });

  it("fails closed when the API is unavailable", async () => {
    await expect(
      verify(async () => {
        throw new Error("GitHub API 403");
      }),
    ).rejects.toThrow("GitHub API 403");
  });

  it("fails closed when the verification workflow is inactive", async () => {
    const api = fixtureAPI();
    await expect(
      verify(async (path) => {
        const result = await api(path);
        return path.endsWith("/dependency-verification.yml") ? { ...result, state: "disabled_manually" } : result;
      }),
    ).rejects.toThrow("missing or inactive");
  });
});

describe("required workflow dependency gate", () => {
  it("runs the trusted verifier only for Renovate and fails the job on rejected dependencies or verification", async () => {
    const root = fileURLToPath(new globalThis.URL("../", import.meta.url));
    const job = yaml.load(readFileSync(join(root, ".github/workflows/no-mistakes-required.yml"), "utf8")).jobs.check;
    const step = job.steps.find(
      (candidate) => candidate.name === "Require dependency verification on the same Renovate head SHA",
    );
    expect(step).toBeDefined();
    for (const author of ["renovate[bot]", "human", "app[bot]", "github-actions[bot]", "dependabot[bot]"]) {
      const enabled = Function(
        "github",
        `return (${job.if ?? "true"}) && (${step.if ?? "true"})`,
      )({
        event: { pull_request: { user: { login: author } } },
      });
      expect(enabled, author).toBe(author === "renovate[bot]");
    }

    const directory = mkdtempSync(join(tmpdir(), "dependency-workflow-"));
    let scenario = { pull: pr, changed: files, runs: [run] };
    const server = createServer((request, response) => {
      fixtureAPI(scenario)(request.url.slice(1)).then(
        (result) => {
          response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
          response.end(JSON.stringify(result));
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      mkdirSync(join(directory, "trusted/scripts"), { recursive: true });
      copyFileSync(
        join(root, "scripts/verify-dependency-pr.mjs"),
        join(directory, "trusted/scripts/verify-dependency-pr.mjs"),
      );
      const event = join(directory, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { number: prNumber, head: { sha } } }));
      const execute = () =>
        promisify(execFile)("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
          cwd: directory,
          timeout: 10000,
          env: {
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
            HOME: directory,
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: repository,
            GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
            GH_TOKEN: "fixture-token",
          },
        });
      await expect(execute()).resolves.toMatchObject({
        stdout: "Renovate dependency verification passed on this exact head SHA.\n",
      });
      scenario = { pull: { ...pr, changed_files: 1 }, changed: [{ filename: "src/cli.ts" }], runs: [run] };
      await expect(execute()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("only package.json") });
      scenario = { pull: pr, changed: files, runs: [{ ...run, conclusion: "failure" }] };
      await expect(execute()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Dependency verification failed"),
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
