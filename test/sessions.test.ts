import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  it("does not create telemetry for ordinary commands, help, status, or failures", () => {
    const { log, env } = setup();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    for (const args of [
      ["plan", "infra/prod", "--expect", "destroy=0", `--token=${secret}`],
      ["state", "/elsewhere/module"],
      ["state", "list", "infra/prod"],
      ["setup", "status"],
      ["plan", "--help"],
      [],
    ])
      try {
        cli(args, { ...env, TERRAFORM_AXI_SESSION: "raw-session-id" });
      } catch {
        /* plan and state are not implemented yet, so they fail and are not recorded */
      }
    expect(existsSync(log)).toBe(false);
    expect(readdirSync(dirname(log))).toEqual(["config.json"]);
  });

  it("leaves existing session history unchanged", () => {
    const { log, env } = setup();
    recordInvocation("plan", "infra/prod", log, sessionKey("old"));
    const before = readFileSync(log, "utf8");
    cli(["setup", "status"], env);
    cli(["plan", "--help"], env);
    try {
      cli(["bogus"], env);
    } catch {
      /* unknown command */
    }
    expect(readFileSync(log, "utf8")).toBe(before);
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

  it("aggregates a session split across rotation and orders same-second sessions by log position", () => {
    const { log } = setup();
    const [a, b] = [sessionKey("a"), sessionKey("b")];
    writeFileSync(`${log}.1`, `${JSON.stringify({ s: a, cmd: "drift", module: null, t: 5 })}\n`);
    writeFileSync(
      log,
      [
        { s: b, cmd: "plan", module: null, t: 9 },
        { s: a, cmd: "state", module: null, t: 9 },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
    );
    expect(lastSession(sessionKey("now"), log)?.commands).toEqual({ drift: 1, state: 1 });
  });

  it("rotates above 1 MB, keeping exactly one old generation", () => {
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
    writeFileSync(log, `${"y".repeat(MAX_BYTES)}\n`, { flag: "a" });
    recordInvocation("drift", "infra/prod", log, old);
    expect(
      readdirSync(dirname(log))
        .filter((file) => file.startsWith("sessions.jsonl"))
        .sort(),
    ).toEqual(["sessions.jsonl", "sessions.jsonl.1"]);
    expect(readFileSync(`${log}.1`, "utf8")).not.toContain('"t":1}');
  });

  it("does not write telemetry from concurrent status commands", async () => {
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
    expect(existsSync(log)).toBe(false);
  });

  it("shows the previous session's commands in the home view and recommends an implemented command", () => {
    const { log, env } = setup(["infra/dev", "infra/prod"]);
    recordInvocation("setup", null, log, sessionKey("one"));
    try {
      cli(["plan", "--bogus"], { ...env, TERRAFORM_AXI_SESSION: "one" });
    } catch {
      /* rejected invocations are not recorded */
    }
    const output = cli([], { ...env, TERRAFORM_AXI_SESSION: "two" });
    expect(output).toMatch(/last_session:\n\s+commands:\n\s+setup: 1\n/);
    expect(output).toContain("next_action: terraform-axi setup status");
    expect(lines(log).map((line) => line.cmd)).toEqual(["setup"]);
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
