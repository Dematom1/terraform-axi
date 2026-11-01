import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
          // Fixture setup only: give the throwaway module state. The product never applies.
          execFileSync(binary, [`-chdir=${directory}`, "apply", "-auto-approve", "-input=false"], {
            stdio: "ignore",
            timeout: 120_000,
            env: { ...env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
          });
          const drift = () =>
            spawnSync(
              process.execPath,
              [join(root, "dist/bin/terraform-axi.js"), "drift", directory, "--binary", binary],
              {
                encoding: "utf8",
                env,
              },
            );
          const clean = drift();
          expect(clean.status, clean.stdout).toBe(0);
          expect(decode(clean.stdout)).toMatchObject({ status: "no drift", drifted: 0 });

          rmSync(join(directory, "f.txt"));
          const sha = () =>
            createHash("sha256")
              .update(readFileSync(join(directory, "terraform.tfstate")))
              .digest("hex");
          const before = { sha: sha(), files: readdirSync(directory).sort() };
          const drifted = drift();
          expect(drifted.status, drifted.stdout).toBe(0);
          expect(decode(drifted.stdout)).toMatchObject({
            version: expect.stringMatching(binary === "tofu" ? /^tofu / : /^terraform /) as string,
            status: "drift detected",
            drifted: 1,
            drift: [{ action: "delete", address: "local_file.f" }],
            human_only: `${binary} -chdir=${directory} apply -refresh-only`,
          });
          expect({ sha: sha(), files: readdirSync(directory).sort() }).toEqual(before);
        } finally {
          rmSync(directory, { recursive: true, force: true });
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    600_000,
  );
});
