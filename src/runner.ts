import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
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
const denied = new Set([
  "apply",
  "destroy",
  "import",
  "init",
  "refresh",
  "taint",
  "untaint",
  "force-unlock",
  "console",
  "login",
  "logout",
  "test",
]);
const deniedState = new Set(["pull", "push", "rm", "mv", "replace-provider", "identities"]);
const deniedWorkspace = new Set(["new", "select", "delete"]);
export function assertAllowed(args: string[]): void {
  if (
    args.some((arg) => denied.has(arg) || arg.startsWith("-out=")) ||
    (args[0] === "state" && args.some((arg) => deniedState.has(arg))) ||
    (args[0] === "workspace" && args.some((arg) => deniedWorkspace.has(arg))) ||
    (args[0] === "show" && args.length > 1)
  )
    throw new CliError("unsupported Terraform argument");
}
export function validateWrapper(wrapper: string): void {
  wrapperArgs(wrapper, "module", []);
}

export function wrapperArgs(wrapper: string, module: string, args: string[]): [string, string[]] {
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
async function resolveBinary(binary: Config["binary"]): Promise<"terraform" | "tofu"> {
  if (binary !== "auto") return binary;
  try {
    await execute("terraform", ["version", "-json"], { timeout: 2_000, env: process.env });
    return "terraform";
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new CliError(
        error && typeof error === "object" && "code" in error && error.code === "EACCES" ? "not executable" : "failed",
      );
    }
  }
  try {
    await execute("tofu", ["version", "-json"], { timeout: 2_000, env: process.env });
    return "tofu";
  } catch (error) {
    throw new CliError(
      error && typeof error === "object" && "code" in error && error.code === "EACCES" ? "not executable" : "not found",
    );
  }
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
    file = await resolveBinary(config.binary);
    if (module) {
      const directory = resolve(module);
      try {
        if (!statSync(directory).isDirectory()) throw new CliError(`module directory not found: ${module}`);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`module directory not found: ${module}`);
      }
      argv = [`-chdir=${directory}`, ...args];
    } else argv = args;
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
