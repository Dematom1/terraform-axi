import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";
import { realModule } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const installed = (binary: string) => {
  try {
    execFileSync(binary, ["version"], {
      stdio: "ignore",
      timeout: 2_000,
      env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), XDG_CONFIG_HOME: tmpdir() },
    });
    return true;
  } catch {
    return false;
  }
};
const binaries = (["terraform", "tofu"] as const).filter(installed);
const requireAll = process.env.TF_AXI_REQUIRE_REAL_BINARIES === "1";

describe("real Terraform and OpenTofu", () => {
  it.runIf(requireAll)("finds both binaries on PATH", () => {
    expect(binaries).toEqual(["terraform", "tofu"]);
  });
  it.skipIf(binaries.length === 0)("reports installed binaries and initializes isolated local modules", async () => {
    const home = mkdtempSync(join(tmpdir(), "tfaxi-real-"));
    const moduleDirs: string[] = [];
    const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    try {
      const output = spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js")], { encoding: "utf8", env });
      expect(output.status).toBe(0);
      expect(() => decode(output.stdout, { strict: true })).not.toThrow();
      for (const binary of binaries) {
        expect(output.stdout).toContain(`${binary}:`);
        const directory = realModule({}, binary);
        moduleDirs.push(directory);
        const result = await run({ binary, modules: [] }, directory);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
      const setup = spawnSync(
        process.execPath,
        [join(root, "dist/bin/terraform-axi.js"), "setup", "--binary", "tofu"],
        { encoding: "utf8", env },
      );
      expect(setup.status).toBe(0);
      const homeOutput = spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js")], {
        encoding: "utf8",
        env,
      });
      expect(homeOutput.stdout).toContain("binary: tofu");
    } finally {
      for (const directory of moduleDirs) rmSync(directory, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });

  it.skipIf(binaries.length === 0)(
    "reports a deleted local_file as drift without touching state",
    () => {
      for (const binary of binaries) {
        const home = mkdtempSync(join(tmpdir(), "tfaxi-drift-real-"));
        const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
        const directory = realModule(
          {
            "main.tf": `terraform {
  backend "local" {}
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}
resource "local_file" "f" {
  filename = "\${path.module}/f.txt"
  content  = "v1"
}
`,
          },
          binary,
          false,
        );
        try {
          execFileSync(binary, [`-chdir=${directory}`, "apply", "-auto-approve", "-input=false"], {
            stdio: "ignore", timeout: 120_000, env: { ...env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
          });
          const drift = () => spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js"), "drift", directory, "--binary", binary], { encoding: "utf8", env });
          expect(drift().status).toBe(0);
          rmSync(join(directory, "f.txt"));
          const sha = () => createHash("sha256").update(readFileSync(join(directory, "terraform.tfstate"))).digest("hex");
          const before = { sha: sha(), files: readdirSync(directory).sort() };
          const drifted = drift();
          expect(drifted.status, drifted.stdout).toBe(0);
          expect(decode(drifted.stdout)).toMatchObject({ status: "drift detected", drifted: 1, drift: [{ action: "delete", address: "local_file.f" }] });
          expect({ sha: sha(), files: readdirSync(directory).sort() }).toEqual(before);
        } finally {
          rmSync(directory, { recursive: true, force: true });
          rmSync(home, { recursive: true, force: true });
        }
      }
    }, 600_000,
  );

  it.skipIf(binaries.length === 0)("lists and redacts state without modifying files", () => {
    const home = mkdtempSync(join(tmpdir(), "tfaxi-state-home-"));
    const temporary = join(home, "tmp");
    const module = join(home, "module");
    const configDir = join(home, ".config");
    const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: configDir, TMPDIR: temporary, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1" };
    mkdirSync(temporary);
    mkdirSync(module);
    writeFileSync(join(module, "main.tf"), 'terraform {\n  backend "local" {}\n}\nresource "terraform_data" "secret" {\n  input = sensitive("hunter2")\n}\nresource "terraform_data" "one" {}\nresource "terraform_data" "two" {}\n', { mode: 0o600 });
    const cli = (args: string[]) => spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js"), ...args], { encoding: "utf8", env });
    try {
      for (const binary of binaries) {
        execFileSync(binary, [`-chdir=${module}`, "init", "-input=false"], { env, timeout: 120_000 });
        execFileSync(binary, [`-chdir=${module}`, "apply", "-auto-approve", "-input=false"], { env, timeout: 120_000 });
        const statePath = join(module, "terraform.tfstate");
        const beforeState = readFileSync(statePath);
        const beforeModuleFiles = readdirSync(module).sort();
        const beforeTempFiles = readdirSync(temporary).sort();
        expect(cli(["setup", "--binary", binary]).status).toBe(0);
        expect(cli(["state", "list", module]).stdout).toContain("total: 3");
        const resource = cli(["state", "resource", module, "terraform_data.secret"]);
        expect(resource.status).toBe(0);
        expect(resource.stdout).toContain('input: "[redacted]"');
        expect(resource.stdout).toContain('output: "[redacted]"');
        expect(`${resource.stdout}${resource.stderr}`).not.toContain("hunter2");
        expect(readFileSync(statePath)).toEqual(beforeState);
        expect(readdirSync(module).sort()).toEqual(beforeModuleFiles);
        expect(readdirSync(temporary).sort()).toEqual(beforeTempFiles);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
