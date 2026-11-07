import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../src/runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("process-group deadlines", () => {
  it("kills grandchildren and settles at the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tfaxi-deadline-"));
    dirs.push(dir);
    const survived = join(dir, "survived");
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `import { spawn } from "node:child_process";\nspawn(process.execPath, ["-e", 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survived)}, "yes"), 2200)'], { stdio: "inherit" });\nsetInterval(() => {}, 1000);\n`,
    );
    const started = Date.now();
    await expect(execute(process.execPath, [stub], { timeout: 1000, maxBuffer: 1024 })).rejects.toMatchObject({
      killed: true,
      signal: "SIGKILL",
    });
    expect(Date.now() - started).toBeLessThan(2500);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(() => readFileSync(survived)).toThrow();
  });
});
