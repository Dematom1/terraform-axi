import {
  installSessionStartHooks,
  runAxiCli,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  plan: async (args) =>
    output({ status: "not implemented in scaffold", requested: args[0] ?? "<module>", help: hints }),
  drift: async () => output({ status: "not implemented in scaffold", help: hints }),
  doctor: async () => output({ status: "not implemented in scaffold", help: hints }),
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
