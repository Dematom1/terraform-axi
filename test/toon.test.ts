import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "dist", "bin", "terraform-axi.js");
describe("CLI output contract", () => {
  it.each([
    [],
    ["--help"],
    ["setup", "--help"],
    ["update", "--help"],
    ["plan", "--help"],
    ["plan"],
    ["setup", "status"],
    ["setup", "--binary", "bogus"],
  ])("emits strict TOON for %s", (...args) => {
    const home = mkdtempSync(join(tmpdir(), "tfaxi-toon-"));
    try {
      const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(() => decode(result.stdout, { strict: true })).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
