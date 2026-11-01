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
import { CliError, ReportError } from "./errors.js";
import { lastSession, recordInvocation } from "./sessions.js";
import { PLAN_ARGS, planCommand, usage as planUsage } from "./plan/command.js";
import { DRIFT_ARGS, drift, driftUsage } from "./commands/drift.js";
import { stateCommand } from "./commands/state.js";
import { inspectBackend } from "./doctor/backend.js";
import { explain } from "./doctor/explain.js";
import { rules } from "./doctor/rules.js";

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
  plan: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage: planUsage,
        runs: PLAN_ARGS.join(" "),
        never: "apply, destroy, -out plan files, state writes",
        help: ["Run `terraform-axi plan <module> --expect add=0,change=0,destroy=0` to assert a no-op plan"],
      });
    return output(await planCommand(args, config()));
  },
  drift: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage: driftUsage,
        runs: DRIFT_ARGS.join(" "),
        never: "apply, refresh, -out plan files, state writes",
        help: ["Run `terraform-axi plan <module>` to see planned configuration changes"],
      });
    return output(await drift(args, config()));
  },
  doctor: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({ usage: "terraform-axi doctor [module]", help: hints });
    if (args.length > 1) throw new CliError("VALIDATION_ERROR: doctor accepts at most one module");
    const module = args[0];
    const backend = module ? inspectBackend(module) : undefined;
    const diagnosis = backend ? rules(process.env, backend) : undefined;
    let binary: unknown;
    let diagnostic: string | undefined;
    try {
      const result = await run(config(), "");
      binary = describeVersion(JSON.parse(result.stdout));
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    return output({
      module: module ?? "not specified",
      binary: binary ?? "unavailable",
      ...(diagnostic ? { error: diagnostic, explanation: explain(diagnostic) } : {}),
      backend: backend
        ? { type: backend.type, reachability: "not probed (static-only; no init or state access)" }
        : "not configured or module not specified",
      credentials: diagnosis?.presence ?? {},
      findings: diagnosis?.findings ?? [],
      ...(module && !backend ? { finding: "No static backend block found." } : {}),
      help: hints,
    });
  },
  state: async (args) =>
    args.length === 1 && args[0] === "--help"
      ? output({
          usage: "terraform-axi state list <module> [--full] | state resource <module> <address> [--full]",
          help: hints,
        })
      : stateCommand(config(), args),
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
      const errors: string[] = [];
      uninstallSessionStartHooks({ marker: name, onError: (message) => errors.push(message) });
      const hooks = sessionStartHookStatus({ marker: name });
      if (errors.length) throw new CliError(`SETUP_FAILED: ${errors.join("; ")}`, 1, errors);
      return output({ hooks, help: hints });
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
      if (errors.length) throw new CliError(`SETUP_FAILED: ${errors.join("; ")}`, 1, errors);
      return output({ hooks: sessionStartHookStatus({ marker: name }), help: hints });
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
const help = `usage: terraform-axi <command> [args]\ncommands[6]:\n  (none)=home, plan, drift, doctor, state, setup\nsummary[6]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary; --expect add=N,change=N,destroy=N asserts counts\n  drift: resources changed outside Terraform/OpenTofu (refresh-only plan)\n  doctor: static backend and credential diagnostics (no state access)\n  state: list resources or inspect one with secrets redacted\n  setup: configure binary, wrapper and modules; hooks, status and uninstall\nsetup[3]:\n  hooks: install user-level SessionStart hooks for supported agents\n  status: show setup config and managed hook status\n  uninstall: remove only terraform-axi-managed user-level hooks\n`;
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
  return output({
    modules: c.modules.length ? c.modules : "none configured",
    ...(session ? { last_session: session } : {}),
    next_action: c.modules.length ? "terraform-axi setup status" : "terraform-axi setup --module <name-or-path>",
    binary: c.binary,
    wrapper: c.wrapper ?? "none",
    versions,
    help: hints,
  });
}
const moduleCommands = ["plan", "drift", "doctor", "state"];
/** The routed command name and a configured module name only, never other argument values. */
export function invocation(argv: string[], modules: string[]): { cmd: string; module: string | null } | undefined {
  const cmd = argv.length === 0 ? "home" : argv[0]!;
  if (cmd !== "home" && (!Object.hasOwn(commands, cmd) || argv.includes("--help"))) return undefined;
  const module = moduleCommands.includes(cmd) ? (argv.slice(1).find((arg) => modules.includes(arg)) ?? null) : null;
  return { cmd, module };
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
      output: `${
        error instanceof ReportError
          ? output(error.report)
          : output({ error: error instanceof Error ? error.message : String(error), help: hints })
      }\n`,
      exitCode: error instanceof CliError ? error.exitCode : 1,
    }),
  });
  // Usage errors (2) and failures (1) are not usage worth remembering; an --expect mismatch (3) is.
  if (process.exitCode === 1 || process.exitCode === 2) return;
  let modules: string[] = [];
  try {
    modules = config().modules;
  } catch {
    /* malformed config: nothing to attribute */
  }
  const used = invocation(argv, modules);
  if (used) recordInvocation(used.cmd, used.module);
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
