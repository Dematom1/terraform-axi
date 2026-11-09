import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "terraform-axi-contract-"));
  env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH ?? "" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function cli(args: string[], installRoot = root) {
  const result = spawnSync(process.execPath, [join(installRoot, "dist/bin/terraform-axi.js"), ...args], {
    env,
    encoding: "utf8",
  });
  return { ...result, report: decode(result.stdout) };
}

describe("setup contract", () => {
  it.each([
    ["setup", "--bogus"],
    ["state", "list", "MODULE", "--bogus"],
  ])("returns a parsed validation code for %j", (...args) => {
    const result = cli(args);
    expect(result.status).not.toBe(0);
    expect(result.report).toMatchObject({ code: "VALIDATION_ERROR", help: expect.any(Array) });
  });

  it.each(["hooks", "uninstall", "status"])("provides real setup %s help without writes", (command) => {
    const result = cli(["setup", command, "--help"]);
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      usage: `terraform-axi setup ${command} [--help]`,
      help: expect.arrayContaining([
        expect.stringContaining(command === "hooks" ? "SessionStart" : command === "status" ? "Read-only" : "Removes"),
        expect.stringContaining(`terraform-axi setup ${command}`),
      ]),
    });
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
  it.each(["list", "resource"])("provides state %s help without executing Terraform", (command) => {
    const result = cli(["state", command, "--help"]);
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      usage:
        command === "list"
          ? "terraform-axi state list <module> [--full]"
          : "terraform-axi state resource <module> <address> [--full]",
      help: expect.arrayContaining([
        expect.stringContaining("Required:"),
        expect.stringContaining("--full:"),
        expect.stringContaining(`terraform-axi state ${command}`),
      ]),
    });
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it.each([
    { name: "object", value: {} },
    { name: "null entry", value: [null] },
    { name: "primitive entry", value: ["x"] },
    { name: "non-array hooks", value: [{ hooks: {} }] },
    { name: "invalid commands", value: [{ hooks: [null, "x", { command: 7 }] }] },
  ])("reads malformed SessionEnd $name without throwing or writing", ({ value }) => {
    const path = join(home, ".claude/settings.json");
    mkdirSync(dirname(path), { recursive: true });
    const original = JSON.stringify({ hooks: { SessionEnd: value } });
    writeFileSync(path, original);
    const result = cli(["setup", "status"]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.report).toMatchObject({ hooks: { claude: { capture_installed: false } } });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["hooks", "uninstall"])("reports invalid SessionEnd groups with their config path during %s", (action) => {
    const path = join(home, ".claude/settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: { SessionEnd: {} } }));
    const result = cli(["setup", action]);
    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({ code: "CONFIG_ERROR", error: expect.stringContaining(path) });
  });

  it.each(["missing", "unmanaged"])("leaves a %s OpenCode plugin untouched during hook deduplication", (kind) => {
    expect(cli(["setup", "hooks"]).status).toBe(0);
    const path = join(home, ".config/opencode/plugins/axi-terraform-axi.js");
    if (kind === "missing") rmSync(path);
    else writeFileSync(path, "// user-owned plugin\n");
    const script = `const { repairHookDuplicates } = await import(${JSON.stringify(pathToFileURL(join(root, "dist/src/hooks.js")).href)}); repairHookDuplicates();`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    if (kind === "missing") expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toBe("// user-owned plugin\n");
    expect(cli(["setup", "status"]).report).toMatchObject({ hooks: { claude: { capture_installed: true } } });
  });

  it.each([
    ["state", "list", "mod", "--bogus"],
    ["setup", "status", "--bogus"],
  ])("retains command-specific guidance on usage errors for %j", (...args) => {
    const result = cli(args);
    expect(result.status).toBe(2);
    expect(result.report).toMatchObject({
      help: expect.arrayContaining([expect.stringContaining(args[0] === "state" ? "Required: module" : "Read-only")]),
    });
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it.each(["malformed", "unreadable"])("reports %s hook settings as an error, not absent", (kind) => {
    const path = join(home, ".claude/settings.json");
    mkdirSync(join(home, ".claude"));
    writeFileSync(path, kind === "malformed" ? "{not json" : "{}");
    if (kind === "unreadable") chmodSync(path, 0);
    try {
      const result = cli(["setup", "status"]);
      expect(result.status).toBe(1);
      expect(result.report).toMatchObject({ code: "CONFIG_ERROR", help: expect.any(Array) });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("returns a setup error with repair hints on a denied configuration write", () => {
    mkdirSync(join(home, ".config"), { mode: 0o500 });
    try {
      const result = cli(["setup", "--binary", "tofu"]);
      expect(result.status).toBe(1);
      expect(result.report).toMatchObject({ code: "SETUP_FAILED", help: expect.any(Array) });
    } finally {
      chmodSync(join(home, ".config"), 0o700);
    }
  });

  it("refreshes all stored hooks after relocation", async () => {
    const original = join(home, "original install");
    const relocated = join(home, "relocated install's copy");
    for (const install of [original, relocated]) {
      mkdirSync(install);
      cpSync(join(root, "dist"), join(install, "dist"), { recursive: true });
      chmodSync(join(install, "dist/bin/terraform-axi-ctx.js"), 0o755);
      cpSync(join(root, "node_modules"), join(install, "node_modules"), { recursive: true });
    }
    expect(cli(["setup", "hooks"], original).status).toBe(0);
    expect(cli(["setup", "hooks"], relocated).status).toBe(0);
    rmSync(original, { recursive: true, force: true });
    expect(existsSync(join(original, "dist/bin/terraform-axi.js"))).toBe(false);

    const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    const claudeCommand = claude.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) => group.hooks)[0]
      .command;
    const codex = JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8"));
    const codexCommand = codex.hooks.SessionStart[0].hooks[0].command;
    for (const command of [claudeCommand, codexCommand]) {
      const executed = spawnSync("/bin/sh", ["-c", command], {
        env: { ...env, PATH: dirname(process.execPath) },
        cwd: tmpdir(),
        input: "{}",
        encoding: "utf8",
      });
      expect(executed.status).toBe(0);
      expect(executed.stdout).toContain("terraform_axi");
    }
    const pluginPath = join(home, ".config/opencode/plugins/axi-terraform-axi.js");
    const pluginUrl = pathToFileURL(pluginPath).href;
    const script = `
      const plugin = (await import(${JSON.stringify(pluginUrl)})).default;
      const handlers = await plugin.server({ directory: process.env.HOME });
      const output = { system: [] };
      await handlers["experimental.chat.system.transform"]({ sessionID: "relocation-check" }, output);
      process.stdout.write(output.system.join("\\n"));
    `;
    const executed = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: dirname(process.execPath) },
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(executed.status).toBe(0);
    expect(executed.stdout).toContain("terraform_axi");
  }, 30_000);

  it("deduplicates legacy hooks, stores executable absolute paths and removes all installed integrations", () => {
    const path = join(home, ".claude/settings.json");
    mkdirSync(join(home, ".claude"));
    const other = { type: "command", command: "other-tool ctx" };
    writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        hooks: {
          SessionStart: [
            { hooks: [other, { command: "/old/terraform-axi-ctx" }, { command: "/old/terraform-axi-ctx" }] },
          ],
          session_start: [{ command: "/old/terraform-axi-ctx" }],
          SessionEnd: [{ hooks: [other] }],
        },
      }),
    );
    expect(cli(["setup", "hooks"]).status).toBe(0);
    expect(cli(["setup", "hooks"]).status).toBe(0);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const hooks = settings.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) => group.hooks);
    const managed = hooks.filter((hook: { command: string }) => hook.command.includes("terraform-axi"));
    expect(managed).toHaveLength(1);
    expect(managed[0].command).toContain(process.execPath);
    expect(managed[0].command).toContain(join(root, "dist/bin/terraform-axi-ctx.js"));
    const executed = spawnSync("/bin/sh", ["-c", managed[0].command], {
      env: { ...env, PATH: "" },
      input: "{}",
      encoding: "utf8",
    });
    expect(executed.status).toBe(0);
    expect(executed.stdout).toContain("terraform_axi");
    expect(cli(["setup", "uninstall"]).status).toBe(0);
    const removed = JSON.parse(readFileSync(path, "utf8"));
    expect(removed).toEqual({
      theme: "dark",
      hooks: {
        SessionStart: [{ hooks: [other] }],
        SessionEnd: [{ hooks: [other] }],
      },
    });
    expect(readFileSync(join(home, ".codex/hooks.json"), "utf8")).not.toContain("terraform-axi");
    expect(existsSync(join(home, ".config/opencode/plugins/axi-terraform-axi.js"))).toBe(false);
  });
});
