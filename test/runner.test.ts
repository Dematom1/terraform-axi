import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, runOperation, validateWrapper } from "../src/runner.js";
import { CliError } from "../src/errors.js";

let dir: string;
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tfaxi-runner-"));
  originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: originalEnv.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") });
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
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
  it("rejects wrapper metacharacters while allowing the exact module placeholder", () => {
    expect(() => validateWrapper("just tf {module}")).not.toThrow();
    for (const character of "|;&$`<>(){}*?![]\n") {
      expect(() => validateWrapper(`just tf {module}${character}`)).toThrow();
    }
    expect(() => validateWrapper("just tf {module} {module}")).toThrow();
    expect(() => validateWrapper("just tf prefix{module}")).toThrow();
    expect(() => validateWrapper("just tf '{module}'")).toThrow();
    expect(() => validateWrapper("just tf \\\\{module}")).toThrow();
  });
  it("runs the fixture executable with named JSONL output and inherited env", async () => {
    const callLog = join(dir, "calls.jsonl");
    vi.stubEnv("TF_AXI_CALL_LOG", callLog);
    vi.stubEnv("TF_AXI_FIXTURE", join(import.meta.dirname, "fixtures", "version.jsonl"));
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret");
    const fixture = join(import.meta.dirname, "fixtures", "fake-terraform.mjs");
    const result = await run(config(`${process.execPath} ${fixture} {module}`), "module-a");
    expect(JSON.parse(result.stdout)).toMatchObject({ terraform_version: "1.2.3" });
    const invocation = JSON.parse(readFileSync(callLog, "utf8")) as {
      argv: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(invocation.argv).toEqual(["module-a", "version", "-json"]);
    expect(invocation.env.AWS_SECRET_ACCESS_KEY).toBe("fixture-secret");
    expect(invocation.env.TF_IN_AUTOMATION).toBe("1");
  });
  it("runs only the fixed read-only state operations", async () => {
    const wrapper = executable("printf '%s\\n' \"$@\"");
    expect(
      (await runOperation(config(`${wrapper} {module}`), "mod", "state_list")).stdout.split("\n").filter(Boolean),
    ).toEqual(["mod", "state", "list"]);
    expect(
      (await runOperation(config(`${wrapper} {module}`), "mod", "show_state")).stdout.split("\n").filter(Boolean),
    ).toEqual(["mod", "show", "-json"]);
    expect((await runOperation(config(`${wrapper} {module}`), "mod", "state_list")).stdout).not.toContain("pull");
  });
  it("reports the bounded state-output limit instead of retrying the tool", async () => {
    const terraform = join(dir, "terraform");
    writeFileSync(
      terraform,
      '#!/bin/sh\nif [ "$1" = "version" ]; then printf \'{"terraform_version":"1.0"}\\n\'; else /usr/bin/head -c 68157440 /dev/zero; fi\n',
      { mode: 0o700 },
    );
    chmodSync(terraform, 0o700);
    vi.stubEnv("PATH", dir);
    await expect(runOperation({ binary: "auto", modules: [] }, dir, "show_state")).rejects.toMatchObject({
      message: "output limit exceeded",
    });
  });
  it("does not treat wrapper words or module names as Terraform operations", async () => {
    const wrapper = executable('printf \'{"terraform_version":"1.2.3"}\\n\'');
    const result = await run(config(`${wrapper} init {module}`), "test");
    expect(result.stdout).toContain("1.2.3");
  });
  it("keeps a wrapper module argument intact and passes the environment through", async () => {
    const log = join(dir, "argv.json");
    const envLog = join(dir, "env.txt");
    const wrapper = executable(
      `printf '%s\\n' "$@" > '${log}'; printf '%s' "$AWS_SECRET_ACCESS_KEY" > '${envLog}'; printf '{"terraform_version":"1.2.3"}\\n'`,
    );
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SENTINEL_TEST_ONLY");
    try {
      const result = await run(config(`${wrapper} {module}`), "infra/a b");
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
    await expect(run({ binary: "auto", modules: [] }, "")).resolves.toMatchObject({
      stdout: "tofu-selected\n",
    });
    const terraform = join(dir, "terraform");
    writeFileSync(terraform, "#!/bin/sh\nprintf 'terraform-selected\\n'\n", { mode: 0o700 });
    chmodSync(terraform, 0o700);
    await expect(run({ binary: "auto", modules: [] }, "")).resolves.toMatchObject({
      stdout: "terraform-selected\n",
    });
  });
  it("falls back to tofu when Terraform's version probe fails", async () => {
    writeFileSync(join(dir, "terraform"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    writeFileSync(join(dir, "tofu"), "#!/bin/sh\nprintf 'tofu-selected\\n'\n", { mode: 0o700 });
    chmodSync(join(dir, "terraform"), 0o700);
    chmodSync(join(dir, "tofu"), 0o700);
    vi.stubEnv("PATH", dir);
    await expect(run({ binary: "auto", modules: [] }, "")).resolves.toMatchObject({
      stdout: "tofu-selected\n",
      fallbackReason: "Terraform probe failed: failed",
    });
  });
  it("falls back to tofu when Terraform fails during the actual invocation", async () => {
    const calls = join(dir, "terraform-calls");
    writeFileSync(
      join(dir, "terraform"),
      `#!/bin/sh\ncount=0\n[ -f '${calls}' ] && read count < '${calls}'\ncount=$((count + 1))\nprintf '%s' "$count" > '${calls}'\n[ "$count" -eq 1 ] && printf '{"terraform_version":"1.0"}\\n' || exit 1\n`,
      { mode: 0o700 },
    );
    writeFileSync(join(dir, "tofu"), "#!/bin/sh\nprintf 'tofu-selected\\n'\n", { mode: 0o700 });
    chmodSync(join(dir, "terraform"), 0o700);
    chmodSync(join(dir, "tofu"), 0o700);
    vi.stubEnv("PATH", dir);
    await expect(run({ binary: "auto", modules: [] }, "")).resolves.toMatchObject({
      stdout: "tofu-selected\n",
      fallbackReason: "Terraform invocation failed: failed",
    });
  });
  it("retains parsed diagnostics on version failures", async () => {
    const failed = executable('printf \'{"type":"diagnostic","diagnostic":{"summary":"bad"}}\\n\'; exit 1');
    await expect(run(config(`${failed} {module}`), "mod")).rejects.toMatchObject({
      message: "failed",
      diagnostics: [{ type: "diagnostic" }],
    });
  });
  it("maps missing executable and timeout", async () => {
    await expect(run(config(`${join(dir, "missing")} {module}`), "mod")).rejects.toThrow("not found");
    const slow = executable("sleep 2");
    await expect(run(config(`${slow} {module}`), "mod", 10)).rejects.toMatchObject({ message: "timeout" });
  });
  it("maps a non-executable binary", async () => {
    const denied = executable("exit 0");
    chmodSync(denied, 0o000);
    await expect(run(config(`${denied} {module}`), "mod")).rejects.toMatchObject({
      message: "not executable",
    });
    chmodSync(denied, 0o700);
  });
  it("maps nonzero exit to failed", async () => {
    const failed = executable("exit 1");
    await expect(run(config(`${failed} {module}`), "mod")).rejects.toBeInstanceOf(CliError);
  });
});
