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
    if (path.includes("/runs?")) return { workflow_runs: runs };
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

  it.each([
    { head_sha: "b".repeat(40) },
    { event: "push" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/ci.yml" },
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

  it("does not reuse an earlier successful run over a new failing or pending run", async () => {
    const failed = { ...run, id: 2, conclusion: "failure" };
    await expect(verify(fixtureAPI({ runs: [run, failed] }))).rejects.toThrow("failed");
    const pending = { ...run, id: 2, status: "in_progress", conclusion: null };
    expect(verificationState([run, pending], context)).toBe("pending");
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

  it("reads every page before accepting files; a forbidden file on page two fails", async () => {
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
