import {
  installSessionStartHooks,
  runAxiCli,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { parseArgs } from "./args.js";
import { readConfig, writeConfig, type Config } from "./config.js";
import { run, validateWrapper } from "./runner.js";
import { CliError } from "./errors.js";
import { lastSession, recordInvocation } from "./sessions.js";

const name = "terraform-axi";
const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name, "config.json");
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
        hooks: sessionStartHookStatus({ marker: name }),
        help: hints,
      });
    if (args[0] === "uninstall") {
      uninstallSessionStartHooks({ marker: name });
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
      return output({
        hooks: errors.length ? errors : sessionStartHookStatus({ marker: name }),
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
  const used = Object.entries(session?.modules ?? {})
    .filter(([module]) => c.modules.includes(module))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const module = used ?? c.modules[0];
  return output({
    modules: c.modules.length ? c.modules : "none configured",
    ...(session ? { last_session: session } : {}),
    next_action: module ? `terraform-axi plan ${module}` : "terraform-axi setup --module <name-or-path>",
    binary: c.binary,
    wrapper: c.wrapper ?? "none",
    versions,
    help: hints,
  });
}
const moduleCommands = ["plan", "drift", "doctor", "state"];
/** Records only the routed command name and a configured module name, never other argument values. */
function record(argv: string[]): void {
  const cmd = argv.length === 0 ? "home" : argv[0]!;
  if (cmd !== "home" && (!Object.hasOwn(commands, cmd) || argv.includes("--help"))) return;
  let module: string | null = null;
  try {
    const modules = config().modules;
    if (moduleCommands.includes(cmd)) module = argv.slice(1).find((arg) => modules.includes(arg)) ?? null;
  } catch {
    /* malformed config: the command reports it */
  }
  recordInvocation(cmd, module);
}
export async function main(
  argv = process.argv.slice(2),
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  record(argv);
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
