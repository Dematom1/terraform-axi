import { installSessionStartHooks, runAxiCli, uninstallSessionStartHooks, type AxiCliCommand } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { parseArgs } from "./args.js";
import { readConfig, writeConfig, type Config } from "./config.js";
import { run, validateWrapper } from "./runner.js";
import { CliError, ReportError, UsageError } from "./errors.js";
import { hookStatus, repairHookDuplicates } from "./hooks.js";
import { lastSession } from "./sessions.js";
import { PLAN_ARGS, planCommand, usage as planUsage } from "./plan/command.js";
import { DRIFT_ARGS, drift, driftUsage } from "./commands/drift.js";
import { stateCommand } from "./commands/state.js";
import { lint, lintUsage } from "./commands/lint.js";
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
  plan: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage: planUsage,
        runs: PLAN_ARGS.join(" "),
        diagnostics:
          "metadata only; provider text and subprocess excerpts withheld; --full lists rows, not diagnostic text",
        wrapper_stdout:
          "plain-text progress counted as skipped_wrapper_lines; JSON-looking lines must be complete JSON events; prefer progress on stderr",
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
        diagnostics: "metadata only; provider text and subprocess excerpts withheld",
        wrapper_stdout:
          "plain-text progress counted as skipped_wrapper_lines; JSON-looking lines must be complete JSON events; prefer progress on stderr",
        never: "apply, refresh, -out plan files, state writes",
        help: ["Run `terraform-axi plan <module>` to see planned configuration changes"],
      });
    return output(await drift(args, config()));
  },
  lint: async (args) =>
    args.length === 1 && args[0] === "--help"
      ? output({
          usage: lintUsage,
          runs: "fmt -check; validate -json only with a data directory; tflint if installed",
          never: "init or format writes",
          examples: ["terraform-axi lint infra/prod", "terraform-axi lint . --binary tofu"],
        })
      : output(await lint(args, config())),
  doctor: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({ usage: "terraform-axi doctor [module] [--offline] | --explain TEXT|-", help: hints });
    if (args[0] === "--explain") {
      if (args.length !== 2) throw new CliError("VALIDATION_ERROR: doctor --explain requires TEXT or -");
      let diagnostic = args[1]!;
      if (diagnostic === "-") {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        diagnostic = Buffer.concat(chunks).toString("utf8");
      }
      const explanation = explain(diagnostic);
      return output({ matched: Boolean(explanation), ...(explanation ?? {}) });
    }
    const offline = args.includes("--offline");
    const positional = args.filter((arg) => arg !== "--offline");
    if (positional.length > 1) throw new CliError("VALIDATION_ERROR: doctor accepts at most one module");
    const module = positional[0];
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
  state: async (args) =>
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && ["list", "resource"].includes(args[0] ?? "") && args[1] === "--help")
      ? output({
          usage:
            args[0] === "list" ? "terraform-axi state list <module> [--full]" :
            args[0] === "resource" ? "terraform-axi state resource <module> <address> [--full]" :
            "terraform-axi state list <module> [--full] | state resource <module> <address> [--full]",
          help: ["Inspect state in a configured module without changing infrastructure."],
        })
      : stateCommand(config(), args),
  setup: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage:
          "terraform-axi setup [--binary terraform|tofu|auto] [--wrapper command] [--module name] [--remove-module name]",
        help: hints,
      });
    if (args.length === 2 && ["status", "hooks", "uninstall"].includes(args[0] ?? "") && args[1] === "--help") {
      const detail =
        args[0] === "status"
          ? "Show Terraform-AXI configuration and installed agent hooks without changing files."
          : args[0] === "hooks"
            ? "Install or repair SessionStart hooks for Claude Code, Codex, and OpenCode."
            : "Remove Terraform-AXI agent hooks while preserving unrelated agent settings.";
      return output({ usage: `terraform-axi setup ${args[0]}`, help: [detail] });
    }
    if (["status", "hooks", "uninstall"].includes(args[0] ?? "") && args.length !== 1)
      throw new CliError("VALIDATION_ERROR: unexpected setup argument");
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
const help = `usage: terraform-axi <command> [args]\ncommands[7]:\n  (none)=home, plan, drift, lint, doctor, state, setup\nsummary[7]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary; --expect add=N,change=N,destroy=N asserts counts\n  drift: resources changed outside Terraform/OpenTofu (refresh-only plan)\n  lint: read-only formatting, initialized validation, and optional tflint findings\n  doctor: backend, reachability and credential diagnostics (no init or state access)\n  state: list resources or inspect one with secrets redacted\n  setup: configure binary, wrapper and modules; hooks, status and uninstall\nsetup[3]:\n  hooks: install user-level SessionStart hooks for supported agents\n  status: show setup config and managed hook status\n  uninstall: remove only terraform-axi-managed user-level hooks\n`;
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
      commands: ["home", "plan", "drift", "lint", "doctor", "state", "setup"],
      help,
    }),
    commands,
    home: async () => home(),
    resolveContext: () => undefined,
    formatError: (error) => ({
      output: `${
        error instanceof ReportError
          ? output(error.report)
          : output({
              code:
                error instanceof UsageError
                  ? "VALIDATION_ERROR"
                  : ((error instanceof CliError ? error.message.match(/^([A-Z_]+):/)?.[1] : undefined) ??
                    (argv[0] === "setup" ? "SETUP_FAILED" : "COMMAND_FAILED")),
              error: error instanceof Error ? error.message : String(error),
              help: ["Check file permissions or repair malformed settings before retrying", ...hints],
            })
      }\n`,
      exitCode: error instanceof CliError ? error.exitCode : 1,
    }),
  });
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
