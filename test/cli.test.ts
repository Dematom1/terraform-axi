import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const root = join(import.meta.dirname, "..");

describe("terraform-axi scaffold", () => {
  it("reports that plan is not implemented in the scaffold", async () => {
    const chunks: string[] = [];
    await main(["plan"], { write: (chunk: string) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("not implemented in scaffold");
  });

  it("ignores an invalid saved modules value in the built CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"modules":null}');
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("modules: none configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
