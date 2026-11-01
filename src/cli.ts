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
import { validateWrapper } from "./runner.js";

const name = "terraform-axi";
const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name, "config.json");
function config(): Config {
  return readConfig(configPath);
}
function output(value: unknown): string {
  return encode(value);
}
function parseWrapperCommand(command: string): string[] | undefined {
  const forbidden = new Set([
    ";",
    "&",
    "|",
    "<",
    ">",
    "$",
    "`",
    "(",
    ")",
    "{",
    "}",
    "*",
    "?",
    "!",
    "[",
    "]",
    "\n",
    "\r",
  ]);
  if ([...command.replaceAll("{module}", "")].some((char) => forbidden.has(char))) return undefined;
  const args: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote || escaped) return undefined;
  if (started) args.push(token);
  return args.length ? args : undefined;
}
const hints = ["Run `terraform-axi setup` to configure Terraform/OpenTofu", "Run `terraform-axi --help` for commands"];
const notImplemented = () => {
  throw new Error("NOT_IMPLEMENTED: command is not implemented in scaffold");
};
const commands: Record<string, AxiCliCommand<undefined>> = {
  plan: async () => notImplemented(),
  drift: async () => notImplemented(),
  doctor: async () => notImplemented(),
  state: async () => notImplemented(),
  update: async (args) => {
    if (args.length === 1 && args[0] === "--help") return output({ usage: "terraform-axi update", help: hints });
    return notImplemented();
  },
  setup: async (args) => {
    if (args.length === 1 && args[0] === "--help")
      return output({
        usage:
          "terraform-axi setup [--binary terraform|tofu|auto] [--wrapper command] [--module name] [--remove-module name]",
        help: hints,
      });
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
const help = `usage: terraform-axi <command> [args]\ncommands[7]:\n  (none)=home, plan, drift, doctor, state, setup, update\nsummary[7]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary (coming soon)\n  drift: detect drift (coming soon)\n  doctor: backend and credential diagnostics (coming soon)\n  state: list resources or inspect one with secrets redacted (coming soon)\n  setup: configure binary, wrapper and modules; hooks, status and uninstall\n  update: check for updates (not implemented)\nsetup[3]:\n  hooks: install user-level SessionStart hooks for supported agents\n  status: show setup config and managed hook status\n  uninstall: remove only terraform-axi-managed user-level hooks\n`;
async function home(): Promise<string> {
  const c = config();
  const versions: Record<string, string> = {};
  if (c.wrapper && c.modules.length === 0) {
    versions.wrapper = "wrapper: not probed (no module configured)";
  }
  const binaries = c.wrapper ? [] : c.binary === "auto" ? ["terraform", "tofu"] : [c.binary];
  for (const binary of binaries) {
    try {
      const { execFileSync } = await import("node:child_process");
      const rawVersion = execFileSync(binary, ["version", "-json"], { encoding: "utf8", timeout: 2000 });
      const version: unknown = JSON.parse(rawVersion);
      versions[binary] =
        version && typeof version === "object" && "terraform_version" in version
          ? String(version.terraform_version)
          : version && typeof version === "object" && "tofu_version" in version
            ? String(version.tofu_version)
            : "version available";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      versions[binary] =
        code === "ENOENT" ? "not found" : `probe failed${typeof code === "string" ? ` (${code})` : ""}`;
    }
  }
  if (c.wrapper && c.modules.length > 0) {
    const wrapperParts = parseWrapperCommand(c.wrapper);
    if (
      !wrapperParts ||
      wrapperParts[0] === "{module}" ||
      wrapperParts.filter((part) => part === "{module}").length !== 1 ||
      wrapperParts.some((part) => part !== "{module}" && part.includes("{module}"))
    ) {
      versions.wrapper = "via wrapper: not probed; wrapper command cannot be represented safely";
    } else {
      const moduleToken = wrapperParts.indexOf("{module}");
      const executable = wrapperParts[0] ?? "";
      const configuredArgs = wrapperParts.slice(1);
      const modulePath = c.modules[0]!;
      const wrapperArgs = configuredArgs.flatMap((arg, index) =>
        index === moduleToken - 1 ? [modulePath, "version", "-json"] : [arg],
      );
      try {
        const { execFileSync } = await import("node:child_process");
        const version: unknown = JSON.parse(execFileSync(executable, wrapperArgs, { encoding: "utf8", timeout: 2000 }));
        const value =
          version && typeof version === "object" && "terraform_version" in version
            ? String(version.terraform_version)
            : version && typeof version === "object" && "tofu_version" in version
              ? String(version.tofu_version)
              : "version available";
        versions.wrapper = `${c.binary === "auto" ? "wrapper-selected/unknown" : c.binary} ${value}`;
      } catch {
        versions.wrapper = "via wrapper: version probe failed";
      }
    }
  }
  return output({
    modules: c.modules.length ? c.modules : "none configured",
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
  await runAxiCli<undefined>({
    description: "Read-only Terraform and OpenTofu for agents",
    version: VERSION,
    argv,
    stdout,
    topLevelHelp: help,
    commands,
    home: async () => home(),
    resolveContext: () => undefined,
    formatError: (error) => ({
      output: output({ error: error instanceof Error ? error.message : String(error), help: hints }),
      exitCode: 1,
    }),
  });
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
