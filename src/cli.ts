import {
  installSessionStartHooks,
  runAxiCli,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

const name = "terraform-axi";
const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name, "config.json");
type Config = { binary: "terraform" | "tofu" | "auto"; wrapper?: string; modules: string[] };
function config(): Config {
  try {
    return { binary: "auto", modules: [], ...JSON.parse(readFileSync(configPath, "utf8")) };
  } catch {
    return { binary: "auto", modules: [] };
  }
}
function output(value: unknown): string {
  return encode(value);
}
const hints = ["Run `terraform-axi setup` to configure Terraform/OpenTofu", "Run `terraform-axi --help` for commands"];
const commands: Record<string, AxiCliCommand<undefined>> = {
  plan: async (args) => {
    const module = args.find((arg) => !arg.startsWith("--"));
    if (!module) throw new Error("Usage: terraform-axi plan <module> [--expect add=N,change=N,destroy=N]");
    const c = config();
    const binary = c.binary === "auto" ? "terraform" : c.binary;
    const lines = execFileSync(c.wrapper ?? binary, [...(c.wrapper ? [binary] : []), "plan", "-input=false", "-no-color", "-json"], { cwd: module, encoding: "utf8", timeout: 120_000 }).trim().split("\\n");
    const changes = { add: 0, change: 0, destroy: 0, replace: 0 };
    for (const line of lines) {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || !("type" in event) || event.type !== "planned_change" || !("change" in event)) continue;
      const actions = (event.change as { action?: unknown }).action;
      if (!Array.isArray(actions)) continue;
      if (actions.includes("create")) changes.add++;
      if (actions.includes("update")) changes.change++;
      if (actions.includes("delete")) changes.destroy++;
      if (actions.includes("create") && actions.includes("delete")) changes.replace++;
    }
    const expectation = args.find((arg) => arg.startsWith("--expect="))?.slice(9) ?? (args.includes("--expect") ? args[args.indexOf("--expect") + 1] : undefined);
    if (expectation) {
      const expected = Object.fromEntries(expectation.split(",").map((part) => part.split("=")));
      const mismatches = Object.entries(expected).filter(([key, value]) => !(key in changes) || changes[key as keyof typeof changes] !== Number(value)).map(([key, value]) => `${key}: expected ${value}, got ${key in changes ? changes[key as keyof typeof changes] : 0}`);
      return output({ ...changes, assertion: mismatches.length ? "fail" : "pass", reasons: mismatches });
    }
    return output(changes);
  },
  drift: async () => output({ status: "not implemented in scaffold", help: hints }),
  doctor: async () => {
    const c = config();
    const binary = c.binary === "auto" ? "terraform" : c.binary;
    let binaryAvailable = false;
    try { execFileSync(c.wrapper ?? binary, [...(c.wrapper ? [binary] : []), "version"], { stdio: "ignore", timeout: 2000 }); binaryAvailable = true; } catch { /* reported below */ }
    return output({ binary: binaryAvailable ? "reachable" : "not found", backend: "not checked (no module selected)", credentials: Object.keys(process.env).filter((key) => /^(AWS|B2)_/.test(key)), precedence: "AWS_* takes precedence over B2_*" });
  },
  state: async (args) =>
    output({
      status: "not implemented in scaffold",
      requested: args.join(" "),
      secrets: "always redacted",
      help: hints,
    }),
  setup: async (args) => {
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
    const settings = config();
    const option = args.indexOf("--binary");
    if (option >= 0 && ["terraform", "tofu", "auto"].includes(args[option + 1] ?? ""))
      settings.binary = args[option + 1] as Config["binary"];
    const wrapper = args.indexOf("--wrapper");
    const wrapperValue = wrapper >= 0 ? args[wrapper + 1] : undefined;
    if (wrapperValue) settings.wrapper = wrapperValue;
    mkdirSync(join(configPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return output({
      setup: "configured",
      config: configPath,
      settings,
      help: ["Run `terraform-axi setup status` to inspect configuration"],
    });
  },
};
const help = `usage: terraform-axi <command> [args]\ncommands[5]:\n  (none)=home, plan, drift, doctor, state, setup\nsummary[6]:\n  (none): configured modules, wrapper and available Terraform/OpenTofu versions\n  plan: read-only plan risk summary (coming soon)\n  drift: detect drift (coming soon)\n  doctor: backend and credential diagnostics (coming soon)\n  state: list resources or inspect one with secrets redacted (coming soon)\n  setup: configure binary and optional wrapper; setup status\n`;
async function home(): Promise<string> {
  const c = config();
  const versions: Record<string, string> = {};
  for (const binary of c.binary === "auto" ? ["terraform", "tofu"] : [c.binary]) {
    try {
      const { execFileSync } = await import("node:child_process");
      const version: unknown = JSON.parse(
        execFileSync(binary, ["version", "-json"], { encoding: "utf8", timeout: 2000 }),
      );
      versions[binary] =
        version && typeof version === "object" && "terraform_version" in version
          ? String(version.terraform_version)
          : "version available";
    } catch {
      versions[binary] = "not found";
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
