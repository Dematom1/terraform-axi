import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.js";
import type { Config } from "./config.js";

const execute = promisify(execFile);
const operations = {
  version: ["version", "-json"],
  plan: ["plan", "-json", "-input=false", "-lock=false", "-detailed-exitcode"],
  plan_refresh_only: ["plan", "-json", "-input=false", "-lock=false", "-detailed-exitcode", "-refresh-only"],
  show_state: ["show", "-json"],
  state_list: ["state", "list"],
  workspace_show: ["workspace", "show"],
  workspace_list: ["workspace", "list"],
} as const;
export type Operation = keyof typeof operations;
const denied = new Set(["apply", "destroy", "import", "taint", "untaint", "force-unlock", "login", "logout"]);
export function assertAllowed(args: string[]): void {
  if (args.some((arg) => denied.has(arg) || arg.startsWith("-out=")))
    throw new CliError("unsupported Terraform argument");
}
function wrapperArgs(wrapper: string, module: string, args: string[]): [string, string[]] {
  if (/[|;&$`<>\r\n]/.test(wrapper)) throw new CliError("wrapper contains shell metacharacters; use a script");
  const words =
    wrapper
      .match(/(?:'[^']*'|"[^"]*"|\\.|[^\s])+/g)
      ?.map((part) =>
        part.replace(/^(?:'([^']*)'|"([^"]*)")$/, (_, single: string, double: string) => single ?? double),
      ) ?? [];
  const indexes = words.flatMap((word, i) => (word === "{module}" ? [i] : []));
  if (
    indexes.length !== 1 ||
    words[0] === "{module}" ||
    words.some((word) => word.includes("{module}") && word !== "{module}")
  )
    throw new CliError("wrapper must contain {module} exactly once");
  words[indexes[0]!] = module;
  return [words[0]!, [...words.slice(1), ...args]];
}
export async function run(
  config: Config,
  module: string,
  operation: Operation,
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  const args = [...operations[operation]];
  assertAllowed(args);
  let file: string;
  let argv: string[];
  if (config.wrapper) [file, argv] = wrapperArgs(config.wrapper, module, args);
  else {
    file = config.binary === "auto" ? "terraform" : config.binary;
    argv = [`-chdir=${module}`, ...args];
  }
  try {
    return await execute(file, argv, {
      timeout: timeout ?? (operation === "version" ? 10_000 : 600_000),
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1" },
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "failed";
    throw new CliError(
      code === "ENOENT"
        ? "not found"
        : code === "EACCES"
          ? "not executable"
          : code === "ETIMEDOUT"
            ? "timeout"
            : "failed",
    );
  }
}
