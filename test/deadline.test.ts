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
  it("counts raw bytes independently for each output stream", async () => {
    const result = await execute(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0xff])); process.stderr.write(Buffer.from([0xfe]))"],
      { timeout: 1000, maxBuffer: 1 },
    );
    expect(result).toEqual({ stdout: "�", stderr: "�" });
  });

  it.each(["stdout", "stderr"])("rejects when %s exceeds maxBuffer", async (stream) => {
    const write = stream === "stdout" ? "process.stdout.write('ab')" : "process.stderr.write('ab')";
    await expect(
      execute(process.execPath, ["-e", `${write}; setInterval(() => {}, 1000)`], {
        timeout: 1000,
        maxBuffer: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("rejects with ENOENT for a missing executable", async () => {
    await expect(execute("terraform-axi-no-such-binary", [], { timeout: 1000, maxBuffer: 1024 })).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it.skipIf(process.platform === "win32")("kills grandchildren and settles at the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tfaxi-deadline-"));
    dirs.push(dir);
    const pidFile = join(dir, "pid");
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });\nwriteFileSync(${JSON.stringify(pidFile)}, String(child.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    const started = Date.now();
    await expect(execute(process.execPath, [stub], { timeout: 1000, maxBuffer: 1024 })).rejects.toMatchObject({
      killed: true,
      signal: "SIGKILL",
    });
    expect(Date.now() - started).toBeLessThan(2500);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it.skipIf(process.platform !== "win32")("settles direct-child timeout on Windows", async () => {
    await expect(
      execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100, maxBuffer: 1024 }),
    ).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
  });
});
