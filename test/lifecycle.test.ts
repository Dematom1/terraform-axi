import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const ctx = join(root, "dist/bin/terraform-axi-ctx.js");
let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tfaxi-lifecycle-"));
  env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH ?? "" };
});
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});
function setup(...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js"), "setup", ...args], {
    env,
    cwd: home,
    encoding: "utf8",
  });
  expect(result.status, result.stdout).toBe(0);
}
const captures = () => join(home, ".config/terraform-axi/captures");
function summary() {
  const result = spawnSync(process.execPath, [ctx], { env, cwd: home, input: "{}", encoding: "utf8" });
  expect(result.status).toBe(0);
  return decode(result.stdout) as { terraform_axi: { last_session: { commands: Record<string, number> } } };
}

it("validates capture flags and answers help before reading input or writing memory", () => {
  for (const args of [["--bogus"], ["--capture", "--bogus"]]) {
    const result = spawnSync(process.execPath, [ctx, ...args], { env, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(decode(result.stdout)).toMatchObject({ code: "VALIDATION_ERROR" });
  }
  const result = spawnSync(process.execPath, [ctx, "--capture", "--help"], { env, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ usage: "terraform-axi-ctx [--capture]" });
  expect(existsSync(join(home, ".config"))).toBe(false);
});

it("keeps fresh and upgraded start-only hook installations byte-identical on repeat", () => {
  for (const upgraded of [false, true]) {
    if (upgraded) {
      setup("uninstall");
      writeFileSync(
        join(home, ".claude/settings.json"),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "/old/terraform-axi-ctx" }] }] } }),
      );
    }
    setup("hooks");
    const paths = [".claude/settings.json", ".codex/hooks.json", ".config/opencode/plugins/axi-terraform-axi.js"].map(
      (path) => join(home, path),
    );
    const first = paths.map((path) => readFileSync(path, "utf8"));
    setup("hooks");
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(first);
  }
});

it.each([".claude/settings.json", ".codex/hooks.json"])(
  "runs installed %s SessionEnd, repairs paths, reports capture and uninstalls without touching unrelated hooks",
  (settingsPath) => {
    const path = join(home, settingsPath);
    mkdirSync(join(path, ".."), { recursive: true });
    const other = { hooks: [{ type: "command", command: "other-tool end" }] };
    writeFileSync(path, JSON.stringify({ hooks: { SessionEnd: [other] } }));
    setup("hooks");
    const first = readFileSync(path, "utf8");
    setup("hooks");
    expect(readFileSync(path, "utf8")).toBe(first);
    const installed = JSON.parse(first);
    const command = installed.hooks.SessionEnd[1].hooks[0].command;
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "terraform-axi state list . --token=SECRET" }),
        },
      }) + "\n",
    );
    const result = spawnSync("/bin/sh", ["-c", command], {
      env,
      cwd: home,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "ended", cwd: home, transcript_path: transcript }),
    });
    expect(result.status, result.stdout).toBe(0);
    expect(summary().terraform_axi.last_session.commands).toEqual({ state: 1 });
    const stored = readFileSync(join(captures(), readdirSync(captures())[0]!), "utf8");
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain(transcript);
    expect(statSync(join(captures(), readdirSync(captures())[0]!)).mode & 0o777).toBe(0o600);
    const status = spawnSync(process.execPath, [join(root, "dist/bin/terraform-axi.js"), "setup", "status"], {
      env,
      encoding: "utf8",
    });
    expect(status.stdout).toContain("capture_installed: true");
    setup("uninstall");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: { SessionEnd: [other] } });
  },
);

it("separates concurrent session writers, atomically replaces retries, and keeps session-start read-only", async () => {
  await Promise.all(
    Array.from(
      { length: 10 },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = execFile(process.execPath, [ctx, "--capture"], { env, cwd: home }, (error) =>
            error ? reject(error) : resolve(),
          );
          child.stdin?.end(JSON.stringify({ session_id: `session-${i}`, cwd: home, commands: { plan: i + 1 } }));
        }),
    ),
  );
  expect(readdirSync(captures())).toHaveLength(10);
  for (const file of readdirSync(captures()))
    expect(JSON.parse(readFileSync(join(captures(), file), "utf8")).commands.plan).toBeGreaterThan(0);
  const retry = spawnSync(process.execPath, [ctx, "--capture"], {
    env,
    input: JSON.stringify({ session_id: "session-1", cwd: home, commands: { plan: 2 } }),
  });
  expect(retry.status).toBe(0);
  expect(readdirSync(captures())).toHaveLength(10);
  const before = readdirSync(captures()).map((file) => readFileSync(join(captures(), file), "utf8"));
  chmodSync(home, 0o500);
  expect(summary().terraform_axi.last_session).toBeDefined();
  expect(readdirSync(captures()).map((file) => readFileSync(join(captures(), file), "utf8"))).toEqual(before);
});

it.each(["v1", "v2"])(
  "installed OpenCode %s plugin injects scoped context and captures session completion",
  (version) => {
    setup("--module", ".");
    setup("hooks");
    const pluginUrl = pathToFileURL(join(home, ".config/opencode/plugins/axi-terraform-axi.js")).href;
    const script = `
    const plugin = (await import(${JSON.stringify(pluginUrl)})).default;
    const version = ${JSON.stringify(version)};
    if (version === "v1") {
      const hooks = await plugin.server({ directory: process.env.HOME });
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "old" }, output);
      if (!output.system.join("").includes("modules[1]: .")) throw Error("missing scoped context");
      await hooks["tool.execute.after"]({ sessionID: "old", args: { command: "terraform-axi plan . --secret=SECRET" } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "old" } } });
    } else {
      let context; let tool; let finished;
      const complete = new Promise(resolve => { finished = resolve; });
      const dispose = await plugin.setup({
        location: { directory: "/not-the-session-directory" },
        session: {
          hook: async (_name, cb) => { context = cb; },
          get: async () => ({ data: { location: { directory: process.env.HOME } } }),
        },
        tool: { hook: async (_name, cb) => { tool = cb; } },
        event: { subscribe: async function* () {
          const output = { sessionID: "old", system: [] };
          await context(output);
          if (!output.system[0].text.includes("modules[1]: .")) throw Error("missing context");
          await tool({ sessionID: "old", input: { command: "terraform-axi plan . --secret=SECRET" } });
          yield { type: "session.idle", data: { sessionID: "old" }, location: { directory: process.env.HOME } };
          finished();
        } },
      });
      await complete;
      dispose();
    }
  `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      cwd: home,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(summary().terraform_axi.last_session.commands).toEqual({ plan: 1 });
  },
);
