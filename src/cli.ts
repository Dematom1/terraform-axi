import {
  installSessionStartHooks,
  runAxiCli,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { homedir } from "node:os";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { parseArgs } from "./args.js";
import { readConfig, writeConfig, type Config } from "./config.js";
import { run, validateWrapper } from "./runner.js";
import { CliError } from "./errors.js";
import { lastSession } from "./sessions.js";

const name = "terraform-axi";
const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name, "config.json");
const claudeSettingsPath = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
const sessionEndCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "terraform-axi-session-end.js"))} # ${name}-session-end`;
function readClaudeSettings(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw new CliError("VALIDATION_ERROR: malformed Claude settings");
  }
}
function writeClaudeSettings(settings: Record<string, unknown>): void {
  mkdirSync(dirname(claudeSettingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\\n`, { mode: 0o600 });
  chmodSync(claudeSettingsPath, 0o600);
}
function sessionEndStatus(settings: Record<string, unknown>): "installed" | "missing" | "stale" {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "missing";
  const groups = (hooks as Record<string, unknown>).SessionEnd;
  if (groups === undefined) return "missing";
  if (!Array.isArray(groups)) return "stale";
  const managed = groups.flatMap((group) => group && typeof group === "object" && Array.isArray((group as Record<string, unknown>).hooks) ? (group as { hooks: unknown[] }).hooks : []).filter((hook) => hook && typeof hook === "object" && typeof (hook as Record<string, unknown>).command === "string" && ((hook as Record<string, unknown>).command as string).includes(`${name}-session-end`)) as Array<Record<string, unknown>>;
  return managed.some((hook) => hook.command === sessionEndCommand) ? "installed" : managed.length ? "stale" : "missing";
}
function updateSessionEnd(settings: Record<string, unknown>, remove: boolean): void {
  const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks as Record<string, unknown> : {};
  const existing = hooks.SessionEnd;
  if (existing !== undefined && !Array.isArray(existing)) throw new CliError("VALIDATION_ERROR: Claude SessionEnd hooks must be an array");
  const groups = (existing ?? []) as Array<Record<string, unknown>>;
  const retained = groups.map((group) => {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return group;
    return { ...group, hooks: group.hooks.filter((hook) => !hook || typeof hook !== "object" || !String((hook as Record<string, unknown>).command ?? "").includes(`${name}-session-end`)) };
  }).filter((group) => !group || typeof group !== "object" || !Array.isArray(group.hooks) || group.hooks.length);
  if (!remove) retained.push({ matcher: "", hooks: [{ type: "command", command: sessionEndCommand, timeout: 10 }] });
  if (retained.length) hooks.SessionEnd = retained; else delete hooks.SessionEnd;
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
}
function config(): Config {
  return readConfig(configPath);
}
function output(value: unknown): string {
  return encode(value);
}
function describeVersion(version: unknown): { flavor: "terraform" | "opentofu" | "unknown"; value: string } {
  if (version && typeof version === "object") {
    if ("terraform_version" in version) return { flavor: "terraform", value: String(version.terraform_version) };
    if ("tofu_version" in version) return { flavor: "opentofu", value: String(version.tofu_version) };
  }
  return { flavor: "unknown", value: "version available" };
}
const hints = ["Run `terraform-axi setup` to configure Terraform/OpenTofu", "Run `terraform-axi --help` for commands"];
const notImplemented = (command: string, args: string[]) => {
  if (args.length === 1 && args[0] === "--help")
    return output({ usage: `terraform-axi ${command} <module>`, status: "not implemented" });
  throw new CliError("NOT_IMPLEMENTED: command is not implemented in scaffold");
};
const commands: Record<string, AxiCliCommand<undefined>> = {
  plan: async (args) => notImplemented("plan", args),
  drift: async (args) => notImplemented("drift", args),
  doctor: async (args) => notImplemented("doctor", args),
  state: async (args) => notImplemented("state", args),
  setup: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage:
          "terraform-axi setup [--binary terraform|tofu|auto] [--wrapper command] [--module name] [--remove-module name]",
        help: hints,
      });
    if (["status", "hooks", "uninstall"].includes(args[0] ?? "") && args.length !== 1)
      throw new CliError("VALIDATION_ERROR: unexpected setup argument");
    if (args[0] === "status")
      return output({
        config: configPath,
        settings: config(),
        hooks: { sessionStart: sessionStartHookStatus({ marker: name }), sessionEnd: sessionEndStatus(readClaudeSettings()) },
        help: hints,
      });
    if (args[0] === "uninstall") {
      uninstallSessionStartHooks({ marker: name });
      const settings = readClaudeSettings();
      updateSessionEnd(settings, true);
      writeClaudeSettings(settings);
      return output({ hooks: "removed", help: hints });
    }
    if (args[0] === "hooks") {
      const errors: string[] = [];
      installSessionStartHooks({
        marker: name,
        execPath: join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "terraform-axi-ctx.js"),
        binaryNames: ["terraform-axi-ctx"],
        distEntrypoints: ["dist/bin/terraform-axi-ctx.js"],
        onError: (message) => errors.push(message),
      });
      const settings = readClaudeSettings();
      updateSessionEnd(settings, false);
      writeClaudeSettings(settings);
      return output({
        hooks: errors.length ? errors : { sessionStart: sessionStartHookStatus({ marker: name }), sessionEnd: sessionEndStatus(settings) },
        help: hints,
      });
    }
    const parsed = parseArgs(args, [
      { name: "--binary", values: ["terraform", "tofu", "auto"] },
      { name: "--wrapper" },
      { name: "--module", repeatable: true },
      { name: "--remove-module", repeatable: true },
    ]);
    if (parsed.command !== undefined || parsed.positional.length)
      throw new CliError("VALIDATION_ERROR: unexpected setup argument");
    const settings = config();
    if (parsed.values["--binary"]?.[0]) settings.binary = parsed.values["--binary"][0] as Config["binary"];
    if (parsed.values["--wrapper"]?.[0]) {
      validateWrapper(parsed.values["--wrapper"][0]!);
      settings.wrapper = parsed.values["--wrapper"][0]!;
    }
    settings.modules = [...new Set([...settings.modules, ...(parsed.values["--module"] ?? [])])];
    for (const remove of parsed.values["--remove-module"] ?? [])
      settings.modules = settings.modules.filter((module) => module !== remove);
    writeConfig(configPath, settings);
    return output({
      setup: "configured",
      config: configPath,
      settings,
      help: ["Run `terraform-axi setup status` to inspect configuration"],
    });
  },
};
const help = `usage: terraform-axi <command> [args]\ncommands[6]:\n  (none)=home, plan, drift, doctor, state, setup\nsummary[6]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary (coming soon)\n  drift: detect drift (coming soon)\n  doctor: backend and credential diagnostics (coming soon)\n  state: list resources or inspect one with secrets redacted (coming soon)\n  setup: configure binary, wrapper and modules; hooks, status and uninstall\nsetup[3]:\n  hooks: install user-level SessionStart hooks for supported agents\n  status: show setup config and managed hook status\n  uninstall: remove only terraform-axi-managed user-level hooks\n`;
async function home(): Promise<string> {
  const c = config();
  const versions: Record<string, string> = {};
  if (c.wrapper && c.modules.length === 0) {
    versions.wrapper = "wrapper: not probed (no module configured)";
  }
  const binaries = c.wrapper ? [] : c.binary === "auto" ? ["terraform", "tofu"] : [c.binary];
  let terraformFailed = false;
  let tofuAvailable = false;
  for (const binary of binaries) {
    try {
      const result = await run({ ...c, binary: binary as Config["binary"] }, "", 2_000);
      const version: unknown = JSON.parse(result.stdout);
      versions[binary] = describeVersion(version).value;
      if (binary === "tofu") tofuAvailable = true;
    } catch (error) {
      versions[binary] = error instanceof Error ? error.message : "probe failed";
      if (binary === "terraform") terraformFailed = true;
    }
  }
  if (c.binary === "auto" && !c.wrapper && terraformFailed && tofuAvailable)
    versions.tofu = `${versions.tofu} (Terraform probe failed: ${versions.terraform})`;
  if (c.wrapper && c.modules.length > 0) {
    try {
      validateWrapper(c.wrapper);
      const result = await run(c, c.modules[0]!, 2_000);
      const version: unknown = JSON.parse(result.stdout);
      const { flavor, value } = describeVersion(version);
      versions.wrapper = `${c.binary === "auto" ? `wrapper-selected/${flavor}` : c.binary} ${value}`;
    } catch (error) {
      versions.wrapper =
        error instanceof Error && error.message.includes("wrapper")
          ? "via wrapper: not probed; wrapper command cannot be represented safely"
          : "via wrapper: version probe failed";
    }
  }
  const session = lastSession();
  const mostUsed = Object.entries(session?.modules ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  return output({
    modules: c.modules.length ? c.modules : "none configured",
    last_session: session,
    next_action: c.modules.length ? `plan ${mostUsed ?? c.modules[0]}` : "setup --module",
    binary: c.binary,
    wrapper: c.wrapper ?? "none",
    versions,
    help: hints,
  });
}
export async function main(
  argv = process.argv.slice(2),
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  if (argv.length === 2 && argv[0] === "update" && argv[1] === "--help") {
    stdout.write(output({ usage: "terraform-axi update", help: hints }));
    return;
  }
  await runAxiCli<undefined>({
    description: "Read-only Terraform and OpenTofu for agents",
    version: VERSION,
    argv,
    stdout,
    topLevelHelp: output({
      usage: "terraform-axi <command> [args]",
      commands: ["home", "plan", "drift", "doctor", "state", "setup"],
      help,
    }),
    commands,
    home: async () => home(),
    resolveContext: () => undefined,
    formatError: (error) => ({
      output: output({ error: error instanceof Error ? error.message : String(error), help: hints }),
      exitCode: error instanceof CliError ? error.exitCode : 1,
    }),
  });
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
