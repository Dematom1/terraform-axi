import {
  AxiError,
  exitCodeForError,
  installSessionStartHooks,
  runAxiCli,
  uninstallSessionStartHooks,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { commandLine, parseArgs } from "./args.js";
import { readConfig, writeConfig, type Config } from "./config.js";
import { run, validateWrapper } from "./runner.js";
import { CliError, ReportError, UsageError } from "./errors.js";
import { hookStatus, repairHookDuplicates } from "./hooks.js";
import { lastSession } from "./sessions.js";
import { lastCapture } from "./capture.js";
import { planCommand } from "./plan/command.js";
import { drift } from "./commands/drift.js";
import { commandHelp } from "./help.js";
import { stateCommand } from "./commands/state.js";
import { lint } from "./commands/lint.js";
import { diagnose } from "./commands/diagnose.js";
import { inspectBackend, probeBackend } from "./doctor/backend.js";
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
const commands: Record<string, AxiCliCommand<undefined>> = {
  plan: async (args) => output(await planCommand(args, config())),
  drift: async (args) => output(await drift(args, config())),
  lint: async (args) => output(await lint(args, config())),
  diagnose: async (args) => output(await diagnose(args)),
  doctor: async (args) => {
    const parsed = parseArgs(args, [{ name: "--offline", boolean: true }, { name: "--explain" }]);
    if (parsed.positional.length) throw new UsageError("doctor accepts at most one module");
    if (parsed.values["--explain"]) {
      if (parsed.command || parsed.values["--offline"])
        throw new UsageError("doctor --explain cannot be combined with a module or --offline");
      let diagnostic = parsed.values["--explain"][0]!;
      if (diagnostic === "-") {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        diagnostic = Buffer.concat(chunks).toString("utf8");
      }
      const explanation = explain(diagnostic);
      return output({ matched: Boolean(explanation), ...(explanation ?? {}) });
    }
    const offline = parsed.values["--offline"] !== undefined;
    const module = parsed.command;
    const backend = module ? inspectBackend(module) : undefined;
    const diagnosis = backend ? rules(process.env, backend) : undefined;
    const reachability = backend
      ? offline
        ? "not probed (offline)"
        : await probeBackend(backend, process.env)
      : undefined;
    return output({
      module: module ?? "not specified",
      backend: backend
        ? {
            type: backend.type,
            ...(backend.endpointHost
              ? { endpoint: `${backend.endpointHost}${backend.endpointPort ? `:${backend.endpointPort}` : ""}` }
              : {}),
            ...(backend.region ? { region: backend.region } : {}),
            reachability,
          }
        : "not configured or module not specified",
      credentials: diagnosis?.presence ?? {},
      findings: diagnosis?.findings ?? [],
      ...(module && !backend ? { finding: "No static backend block found." } : {}),
      help: hints,
    });
  },
  state: async (args) => stateCommand(config(), args),
  setup: async (args) => {
    if (["status", "hooks", "uninstall"].includes(args[0] ?? "") && args.length !== 1) {
      parseArgs(args.slice(1), []);
      throw new UsageError("unexpected setup argument");
    }
    if (args[0] === "status")
      return output({
        config: configPath,
        settings: config(),
        hooks: hookStatus(),
        help: hints,
      });
    if (args[0] === "uninstall") {
      // Codex [features].hooks is shared across tools, so uninstall retains it to avoid disabling other tools' hooks.
      const errors: string[] = [];
      repairHookDuplicates(true);
      uninstallSessionStartHooks({ marker: name, onError: (message) => errors.push(message) });
      const hooks = hookStatus();
      if (errors.length) throw new CliError(`SETUP_FAILED: ${errors.join("; ")}`, 1, errors);
      return output({ hooks, help: hints });
    }
    if (args[0] === "hooks") {
      const errors: string[] = [];
      installSessionStartHooks({
        marker: name,
        execPath: join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "terraform-axi-ctx.js"),
        // Keep the absolute entrypoint: an npx PATH disappears after setup exits.
        binaryNames: [],
        distEntrypoints: ["dist/bin/terraform-axi-ctx.js"],
        onError: (message) => errors.push(message),
      });
      if (errors.length) throw new CliError(`SETUP_FAILED: ${errors.join("; ")}`, 1, errors);
      repairHookDuplicates();
      return output({ hooks: hookStatus(), help: hints });
    }
    const parsed = parseArgs(args, [
      { name: "--binary", values: ["terraform", "tofu", "auto"] },
      { name: "--wrapper" },
      { name: "--module", repeatable: true },
      { name: "--remove-module", repeatable: true },
    ]);
    if (parsed.command !== undefined || parsed.positional.length) throw new UsageError("unexpected setup argument");
    const settings = config();
    if (parsed.values["--binary"]?.[0]) settings.binary = parsed.values["--binary"][0] as Config["binary"];
    if (parsed.values["--wrapper"]?.[0]) {
      try {
        validateWrapper(parsed.values["--wrapper"][0]!);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : "invalid wrapper");
      }
      settings.wrapper = parsed.values["--wrapper"][0]!;
    }
    const added = parsed.values["--module"] ?? [];
    settings.modules = [...new Set([...settings.modules, ...added])];
    if (added.length)
      settings.moduleDirectories = Object.fromEntries([
        ...Object.entries(settings.moduleDirectories ?? {}),
        ...added.map((module) => [module, resolve(module)]),
      ]);
    for (const remove of parsed.values["--remove-module"] ?? []) {
      settings.modules = settings.modules.filter((module) => module !== remove);
      if (settings.moduleDirectories) delete settings.moduleDirectories[remove];
    }
    writeConfig(configPath, settings);
    return output({
      setup: "configured",
      config: configPath,
      settings,
      help: ["Run `terraform-axi setup status` to inspect configuration"],
    });
  },
};
const help = `usage: terraform-axi <command> [args]\ncommands[8]:\n  (none)=home, plan, drift, lint, diagnose, doctor, state, setup\nsummary[8]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary; --expect add=N,change=N,destroy=N asserts counts\n  drift: resources changed outside Terraform/OpenTofu (refresh-only plan)\n  lint: read-only formatting, initialized validation, and optional tflint findings\n  diagnose: value-free failures and summary from a saved plan/apply -json stream or log\n  doctor: backend, reachability and credential diagnostics (no init or state access)\n  state: list resources or inspect one with secrets redacted\n  setup: configure binary, wrapper and modules; hooks, status and uninstall\nsetup[3]:\n  hooks: install user-level SessionStart and SessionEnd integrations for supported agents\n  status: show setup config and managed hook status\n  uninstall: remove only terraform-axi-managed user-level hooks\n`;
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
  const session = lastCapture(process.cwd(), process.env.TERRAFORM_AXI_SESSION) ?? lastSession();
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
export async function main(
  argv = process.argv.slice(2),
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  if (argv[0] === "update" && argv.includes("--help")) {
    stdout.write(`${output(commandHelp("update"))}\n`);
    return;
  }
  const subcommand =
    (argv[0] === "state" && ["list", "resource"].includes(argv[1] ?? "")) ||
    (argv[0] === "setup" && ["status", "hooks", "uninstall"].includes(argv[1] ?? ""))
      ? argv[1]
      : undefined;
  const reference = commandLine([argv[0] ?? "", ...(subcommand ? [subcommand] : []), "--help"]);
  await runAxiCli<undefined>({
    description: "Read-only Terraform and OpenTofu for agents",
    version: VERSION,
    argv,
    stdout,
    topLevelHelp: output({
      usage: "terraform-axi <command> [args]",
      commands: ["home", "plan", "drift", "lint", "diagnose", "doctor", "state", "setup"],
      help,
    }),
    commands,
    getCommandHelp: (command) =>
      Object.hasOwn(commands, command) ? `${output(commandHelp(command, argv[1]))}\n` : undefined,
    renderUnknownCommand: (command) =>
      `${output({ code: "VALIDATION_ERROR", error: `unknown command: ${command}`, help: ["Run `terraform-axi --help` to choose a command"] })}\n`,
    home: async () => home(),
    resolveContext: () => undefined,
    formatError: (error) => {
      const usageError =
        error instanceof UsageError || (error instanceof AxiError && error.code === "VALIDATION_ERROR");
      const guidance = commandHelp(argv[0] ?? "", argv[1]);
      return {
        output: `${
          error instanceof ReportError
            ? output(error.report)
            : output({
                code: usageError
                  ? "VALIDATION_ERROR"
                  : error instanceof AxiError
                    ? error.code
                    : ((error instanceof CliError ? error.message.match(/^([A-Z_]+):/)?.[1] : undefined) ??
                      (argv[0] === "setup" ? "SETUP_FAILED" : "COMMAND_FAILED")),
                error: error instanceof Error ? error.message : String(error),
                ...(usageError ? guidance : {}),
                help: usageError
                  ? [
                      `Run \`${reference}\` for this invocation's reference`,
                      ...guidance.flags,
                      ...(guidance.help ?? []),
                    ]
                  : error instanceof CliError && /CONFIG_|SETUP_|malformed config/.test(error.message)
                    ? ["Check file permissions or repair malformed settings before retrying", ...hints]
                    : [`Check the selected input and prerequisites, then retry \`${commandLine(argv)}\``],
              })
        }\n`,
        exitCode: error instanceof CliError ? error.exitCode : error instanceof AxiError ? exitCodeForError(error) : 1,
      };
    },
  });
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
