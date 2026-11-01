import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastSession, MAX_BYTES, recordInvocation, sessionKey } from "../src/sessions.js";

const root = join(import.meta.dirname, "..");
let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function setup(modules: string[] = ["infra/prod"]): { log: string; env: Record<string, string> } {
  home = mkdtempSync(join(tmpdir(), "terraform-axi-session-"));
  const dir = join(home, ".config", "terraform-axi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ binary: "terraform", modules }));
  return {
    log: join(dir, "sessions.jsonl"),
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  };
}
const cli = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js"), ...args], { encoding: "utf8", env });
const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("session memory", () => {
  it("appends one line per invocation with only command, configured module, hashed session and time", () => {
    const { log, env } = setup();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    for (const args of [
      ["plan", "infra/prod", "--expect", "destroy=0", `--token=${secret}`],
      ["state", "/elsewhere/module"],
      ["state", "list", "infra/prod"],
      [],
    ])
      try {
        cli(args, { ...env, TERRAFORM_AXI_SESSION: "raw-session-id" });
      } catch {
        /* plan and state are not implemented yet; recording still happens */
      }
    const raw = readFileSync(log, "utf8");
    for (const leaked of ["destroy=0", "--expect", secret, "raw-session-id", "/elsewhere", home])
      expect(raw).not.toContain(leaked);
    const s = sessionKey("raw-session-id");
    expect(s).toMatch(/^[0-9a-f]{12}$/);
    expect(lines(log).map(({ t, ...rest }) => (expect(typeof t).toBe("number"), rest))).toEqual([
      { s, cmd: "plan", module: "infra/prod" },
      { s, cmd: "state", module: null },
      { s, cmd: "state", module: "infra/prod" },
      { s, cmd: "home", module: null },
    ]);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("records unkeyed lines without a session id and skips help and unknown commands", () => {
    const { log, env } = setup();
    cli(["setup", "status"], env);
    cli(["plan", "--help"], env);
    try {
      cli(["bogus"], env);
    } catch {
      /* unknown command */
    }
    expect(lines(log).map((line) => [line.s, line.cmd])).toEqual([[null, "setup"]]);
  });

  it("groups the most recent other session and ignores the current one, unkeyed and malformed lines", () => {
    const { log } = setup();
    const [a, b, current] = [sessionKey("a"), sessionKey("b"), sessionKey("current")];
    recordInvocation("plan", "infra/prod", log, a);
    recordInvocation("plan", "infra/prod", log, b);
    recordInvocation("drift", "infra/prod", log, b);
    writeFileSync(log, "{not json\n", { flag: "a" });
    recordInvocation("state", null, log, b);
    recordInvocation("doctor", null, log, null);
    recordInvocation("home", null, log, current);
    expect(lastSession(current, log)).toMatchObject({
      commands: { plan: 1, drift: 1, state: 1 },
      modules: { "infra/prod": 2 },
    });
    expect(lastSession(b, log)?.commands).toEqual({ home: 1 });
    expect(lastSession(current, join(home, "missing.jsonl"))).toBeUndefined();
  });

  it("rotates above 1 MB, keeps one old generation, and still finds the previous session", () => {
    const { log } = setup();
    const old = sessionKey("old");
    writeFileSync(
      log,
      `${"x".repeat(MAX_BYTES)}\n${JSON.stringify({ s: old, cmd: "drift", module: "infra/prod", t: 1 })}\n`,
    );
    recordInvocation("home", null, log, sessionKey("now"));
    recordInvocation("plan", null, log, sessionKey("now"));
    expect(readFileSync(`${log}.1`, "utf8")).toContain('"drift"');
    expect(lines(log).map((line) => line.cmd)).toEqual(["home", "plan"]);
    expect(lastSession(sessionKey("now"), log)).toEqual({
      commands: { drift: 1 },
      modules: { "infra/prod": 1 },
      ended_at: "1970-01-01T00:00:01.000Z",
    });
    expect(lastSession(old, log)?.commands).toEqual({ home: 1, plan: 1 });
  });

  it("keeps every line from concurrent CLI processes", async () => {
    const { log, env } = setup();
    const { execFile } = await import("node:child_process");
    await Promise.all(
      Array.from(
        { length: 10 },
        (_, i) =>
          new Promise((resolve) =>
            execFile(
              process.execPath,
              [join(root, "dist", "bin", "terraform-axi.js"), "setup", "status"],
              { env: { ...env, TERRAFORM_AXI_SESSION: `s${i}` } },
              resolve,
            ),
          ),
      ),
    );
    expect(new Set(lines(log).map((line) => line.s)).size).toBe(10);
  });

  it("shows last_session and the next plan in the home view", () => {
    const { env } = setup(["infra/dev", "infra/prod"]);
    cli(["setup", "status"], { ...env, TERRAFORM_AXI_SESSION: "one" });
    try {
      cli(["plan", "infra/prod"], { ...env, TERRAFORM_AXI_SESSION: "one" });
    } catch {
      /* not implemented */
    }
    const output = cli([], { ...env, TERRAFORM_AXI_SESSION: "two" });
    expect(output).toContain("last_session");
    expect(output).toContain("next_action: terraform-axi plan infra/prod");
    expect(cli([], { ...env, TERRAFORM_AXI_SESSION: "one" })).toContain("next_action: terraform-axi plan infra/dev");
  });

  it("suggests registering a module when none is configured", () => {
    const { env } = setup([]);
    expect(cli([], env)).toContain("next_action: terraform-axi setup --module <name-or-path>");
  });

  it("SessionStart context exports the session id and shows last_session quickly without subprocesses", () => {
    const { log, env } = setup();
    recordInvocation("plan", "infra/prod", log, sessionKey("earlier"));
    const envFile = join(home, "claude-env");
    const started = performance.now();
    const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi-ctx.js")], {
      encoding: "utf8",
      input: JSON.stringify({ session_id: "fresh-session" }),
      env: { ...env, PATH: "", CLAUDE_ENV_FILE: envFile },
    });
    expect(performance.now() - started).toBeLessThan(200);
    expect(readFileSync(envFile, "utf8")).toBe("export TERRAFORM_AXI_SESSION=fresh-session\n");
    expect(output).toContain("last_session");
    expect(output).toContain("writes: never");
    expect(readFileSync(join(root, "dist", "bin", "terraform-axi-ctx.js"), "utf8")).not.toContain("child_process");
  });

  it("does not export unsafe session ids", () => {
    const { env } = setup();
    const envFile = join(home, "claude-env");
    execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi-ctx.js")], {
      input: JSON.stringify({ session_id: "x; rm -rf ~" }),
      env: { ...env, CLAUDE_ENV_FILE: envFile },
    });
    expect(existsSync(envFile)).toBe(false);
  });

  it("installs, reports, and uninstalls the SessionStart hook while preserving unrelated hooks", () => {
    const { env } = setup();
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const unrelated = {
      theme: "dark",
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "other-tool ctx" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }, "malformed-group"],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(unrelated));
    cli(["setup", "hooks"], env);
    cli(["setup", "hooks"], env);
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    const commands = installed.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((hook) => hook.command),
    );
    expect(commands.filter((command: string) => command.includes("terraform-axi-ctx"))).toHaveLength(1);
    expect(commands).toContain("other-tool ctx");
    expect(cli(["setup", "status"], env)).toMatch(/claude:\n\s+installed: true/);
    cli(["setup", "uninstall"], env);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(unrelated);
    expect(cli(["setup", "status"], env)).toMatch(/claude:\n\s+installed: false/);
  });
});
