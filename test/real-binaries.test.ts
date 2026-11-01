import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { realModule } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const installed = (binary: string) => {
  try {
    execFileSync(binary, ["version"], { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
};
const binaries = ["terraform", "tofu"].filter(installed);

describe("real Terraform and OpenTofu", () => {
  it.skipIf(binaries.length === 0)("reports installed binaries and initializes isolated local modules", () => {
    const home = mkdtempSync(join(tmpdir(), "tfaxi-real-"));
    const moduleDirs: string[] = [];
    const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    try {
      const output = spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js")], { encoding: "utf8", env });
      expect(output.status).toBe(0);
      expect(() => decode(output.stdout, { strict: true })).not.toThrow();
      for (const binary of binaries) {
        expect(output.stdout).toContain(`${binary}:`);
        moduleDirs.push(realModule({}, binary));
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
    }
  });
});
