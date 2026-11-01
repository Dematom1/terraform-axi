import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("terraform-axi plan", () => {
  it("counts actions from Terraform JSON events and checks expectations", async () => {
    const root = mkdtempSync(join(tmpdir(), "terraform-axi-"));
    const module = join(root, "module");
    const bin = join(root, "bin");
    mkdirSync(module);
    mkdirSync(bin);
    const terraform = join(bin, "terraform");
    writeFileSync(terraform, `#!/bin/sh\nprintf '%s\\n' '{"type":"planned_change","change":{"actions":["create"]}}' '{"type":"planned_change","change":{"actions":["delete","create"]}}'`);
    chmodSync(terraform, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const chunks: string[] = [];
      await main(["plan", module, "--expect", "add=2,destroy=1,replace=1"], { write: (chunk: string) => chunks.push(chunk) });
      expect(chunks.join("")).toContain("assertion: pass");
      expect(chunks.join("")).toContain("replace: 1");
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
