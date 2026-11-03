import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, describe, expect, it } from "vitest";
import { realModule } from "./helpers.js";

const cli = join(import.meta.dirname, "..", "dist", "bin", "terraform-axi.js");
const which = (binary: string) => {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${binary}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const binaries = (["terraform", "tofu"] as const).filter((binary) => which(binary));

if (binaries.length === 0) it.skip("requires Terraform or OpenTofu", () => {});

// Prior state is written by hand so the plan has something to update, replace, and destroy; nothing is applied.
const resource = (name: string, attributes: Record<string, unknown>) => ({
  mode: "managed",
  type: "terraform_data",
  name,
  provider: 'provider["terraform.io/builtin/terraform"]',
  instances: [
    {
      schema_version: 0,
      attributes: { id: `${name}-id`, input: null, output: null, triggers_replace: null, ...attributes },
      sensitive_attributes: [],
    },
  ],
});
const state = JSON.stringify({
  version: 4,
  terraform_version: "1.0.0",
  serial: 1,
  lineage: "00000000-0000-0000-0000-000000000001",
  outputs: { token: { value: "before-SENTINEL", type: "string", sensitive: true } },
  resources: [
    resource("keep", { input: { value: "v1", type: "string" }, output: { value: "v1", type: "string" } }),
    resource("repl", { triggers_replace: { value: "v1", type: "string" } }),
    resource("gone", {}),
  ],
});
const main = `terraform {
  backend "local" {}
}
resource "terraform_data" "keep" { input = "v2" }
resource "terraform_data" "repl" { triggers_replace = "v2" }
resource "terraform_data" "new" {}
output "token" {
  value     = "after-SENTINEL"
  sensitive = true
}
`;

const cleanup: string[] = [];
afterAll(() => {
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
});
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.each(binaries)("plan with real %s on a throwaway local-backend module", (binary) => {
  const home = mkdtempSync(join(tmpdir(), "tfaxi-real-plan-"));
  cleanup.push(home);
  // Only PATH reaches the CLI: no cloud credentials, no TF_* variables.
  const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const configure = (config: object) => {
    mkdirSync(join(home, ".config", "terraform-axi"), { recursive: true });
    writeFileSync(join(home, ".config", "terraform-axi", "config.json"), JSON.stringify(config));
  };
  const tfaxi = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, timeout: 120_000 });
    return { status: result.status, stdout: result.stdout, report: decode(result.stdout) as Record<string, unknown> };
  };
  const module = realModule({ "main.tf": main, "terraform.tfstate": state }, binary);
  cleanup.push(module);
  const before = { files: readdirSync(module).sort(), state: sha(join(module, "terraform.tfstate")) };
  const flavor = binary === "tofu" ? "tofu" : "terraform";

  it("summarizes risk, passes a matching --expect, and leaves the module untouched", () => {
    configure({ binary, modules: [] });
    const { status, report, stdout } = tfaxi(["plan", module, "--expect", "add=2,change=1,destroy=2"]);
    expect(status).toBe(0);
    expect(report).toMatchObject({
      status: "planned",
      summary: { add: 2, change: 1, destroy: 2 },
      risk: { high: 3, low: 2 },
      expect: { status: "pass" },
    });
    expect(String(report.version)).toMatch(new RegExp(`^${flavor} `));
    const rows = Object.fromEntries(
      (report.changes as { address: string; action: string; flags: string }[]).map((r) => [
        r.address,
        `${r.action} ${r.flags}`.trim(),
      ]),
    );
    expect(rows).toEqual({
      "terraform_data.gone": "DESTROY destroy",
      "terraform_data.repl": "REPLACE destroy replace(cannot_update)",
      "output.token": "update secret",
      "terraform_data.keep": "update",
      "terraform_data.new": "create",
    });
    expect(JSON.stringify(report.help ?? [])).not.toContain("apply");
    expect(stdout).not.toContain("SENTINEL");
    // No plan file, no state write, no lock left behind.
    expect(readdirSync(module).sort()).toEqual(before.files);
    expect(sha(join(module, "terraform.tfstate"))).toBe(before.state);
  });

  it("fails a mismatched --expect with reasons", () => {
    configure({ binary, modules: [] });
    const { status, report } = tfaxi(["plan", module, "--expect", "destroy=0"]);
    expect(status).toBe(1);
    expect(report.expect).toEqual({
      status: "fail",
      reasons: [expect.stringMatching(/^destroy: expected 0, planned 2 \(.*terraform_data\.gone DESTROY/)],
    });
  });

  it("runs through a configured wrapper command", () => {
    const wrapper = join(home, "tf-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\nmodule=$1\nshift\nexec ${which(binary)} -chdir="$module" "$@"\n`, {
      mode: 0o700,
    });
    configure({ binary: "auto", modules: [module], wrapper: `${wrapper} {module}` });
    const { status, report } = tfaxi(["plan", module, "--expect", "add=2,change=1,destroy=2"]);
    expect(status).toBe(0);
    expect(report).toMatchObject({ via: "wrapper", expect: { status: "pass" } });
    expect(JSON.stringify(report.help ?? [])).not.toContain("apply");
    expect(readdirSync(module).sort()).toEqual(before.files);
    expect(sha(join(module, "terraform.tfstate"))).toBe(before.state);
  });

  it("reports a configuration error with its diagnostic", () => {
    const broken = realModule(
      { "main.tf": 'resource "terraform_data" "bad" { input = terraform_data.missing.id }\n' },
      binary,
    );
    cleanup.push(broken);
    configure({ binary, modules: [] });
    const { status, report } = tfaxi(["plan", broken]);
    expect(status).toBe(1);
    expect(report.status).toBe("error");
    expect(report.diagnostics).toEqual([{ severity: "error", category: "terraform_diagnostic" }]);
  });
});
