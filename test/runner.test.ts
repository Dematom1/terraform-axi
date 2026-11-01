import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/runner.js";
import { CliError } from "../src/errors.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tfaxi-runner-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function executable(body: string): string {
  const path = join(dir, `fake-${Math.random().toString(16).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
const config = (wrapper: string) => ({ binary: "auto" as const, modules: [], wrapper });

describe("runner seam", () => {
  it("keeps a wrapper module argument intact and passes the environment through", async () => {
    const log = join(dir, "argv.json");
    const envLog = join(dir, "env.txt");
    const wrapper = executable(
      `printf '%s\\n' "$@" > '${log}'; printf '%s' "$AWS_SECRET_ACCESS_KEY" > '${envLog}'; printf '{"terraform_version":"1.2.3"}\\n'`,
    );
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SENTINEL_TEST_ONLY");
    try {
      const result = await run(config(`${wrapper} {module}`), "infra/a b", "version");
      expect(result.stdout).toContain("1.2.3");
      expect(readFileSync(log, "utf8").split("\n").slice(0, 3)).toEqual(["infra/a b", "version", "-json"]);
      expect(readFileSync(envLog, "utf8")).toBe("SENTINEL_TEST_ONLY");
      expect(result.stdout).not.toContain("SENTINEL_TEST_ONLY");
      expect(result.stderr).not.toContain("SENTINEL_TEST_ONLY");
      expect(JSON.stringify(config(`${wrapper} {module}`))).not.toContain("SENTINEL_TEST_ONLY");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("selects tofu when it is the only installed binary and terraform when both exist", async () => {
    const tofu = join(dir, "tofu");
    writeFileSync(tofu, "#!/bin/sh\nprintf 'tofu-selected\\n'\n", { mode: 0o700 });
    chmodSync(tofu, 0o700);
    vi.stubEnv("PATH", dir);
    await expect(run({ binary: "auto", modules: [] }, "", "workspace_show")).resolves.toMatchObject({
      stdout: "tofu-selected\n",
    });
    const terraform = join(dir, "terraform");
    writeFileSync(terraform, "#!/bin/sh\nprintf 'terraform-selected\\n'\n", { mode: 0o700 });
    chmodSync(terraform, 0o700);
    await expect(run({ binary: "auto", modules: [] }, "", "workspace_show")).resolves.toMatchObject({
      stdout: "terraform-selected\n",
    });
  });
  it("accepts plan exit 2 and retains parsed diagnostics on failures", async () => {
    const changed = executable('printf \'{"type":"change_summary"}\\n\'; exit 2');
    await expect(run(config(`${changed} {module}`), "mod", "plan")).resolves.toMatchObject({
      stdout: expect.stringContaining("change_summary"),
    });
    const failed = executable('printf \'{"type":"diagnostic","diagnostic":{"summary":"bad"}}\\n\'; exit 1');
    await expect(run(config(`${failed} {module}`), "mod", "plan")).rejects.toMatchObject({
      message: "failed",
      diagnostics: [{ type: "diagnostic" }],
    });
  });
  it("maps missing executable and timeout", async () => {
    await expect(run(config(`${join(dir, "missing")} {module}`), "mod", "version")).rejects.toThrow("not found");
    const slow = executable("sleep 2");
    await expect(run(config(`${slow} {module}`), "mod", "version", 10)).rejects.toMatchObject({ message: "timeout" });
  });
  it("maps a non-executable binary", async () => {
    const denied = executable("exit 0");
    chmodSync(denied, 0o000);
    await expect(run(config(`${denied} {module}`), "mod", "version")).rejects.toMatchObject({
      message: "not executable",
    });
    chmodSync(denied, 0o700);
  });
  it("maps nonzero exit to failed", async () => {
    const failed = executable("exit 1");
    await expect(run(config(`${failed} {module}`), "mod", "version")).rejects.toBeInstanceOf(CliError);
  });
});
