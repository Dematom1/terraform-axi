import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "./errors.js";
import { diagnosticMetadata, parsePlanEvents } from "./plan/events.js";
import type { Config } from "./config.js";

const execute = promisify(execFile);
const versionArgs = ["version", "-json"];
// TF_CLI_ARGS* could append arbitrary flags, such as -out=, writing a plan with secrets.
const runEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TF_CLI_ARGS"))),
  TF_IN_AUTOMATION: "1",
  TF_INPUT: "0",
  CHECKPOINT_DISABLE: "1",
});
function classify(error: unknown): "not found" | "not executable" | "timeout" | "output limit exceeded" | "failed" {
  const record = error && typeof error === "object" ? error : {};
  if ("code" in record && record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output limit exceeded";
  if ("code" in record && record.code === "ENOENT") return "not found";
  if ("code" in record && record.code === "EACCES") return "not executable";
  if (
    ("code" in record && record.code === "ETIMEDOUT") ||
    ("killed" in record && record.killed === true) ||
    ("signal" in record && record.signal === "SIGKILL")
  )
    return "timeout";
  return "failed";
}
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
    args.some((arg) => denied.has(arg) || arg === "-out" || arg.startsWith("-out=")) ||
    (args[0] === "state" && args.some((arg) => deniedState.has(arg))) ||
    (args[0] === "workspace" && args.some((arg) => deniedWorkspace.has(arg))) ||
    (args[0] === "show" && !(args.length === 2 && args[1] === "-json"))
  )
    throw new CliError("unsupported Terraform argument");
}
export function validateWrapper(wrapper: string): void {
  wrapperArgs(wrapper, "module", []);
}

export function wrapperArgs(wrapper: string, module: string, args: string[]): [string, string[]] {
  if (/[|;&$`(){}*?![\]\\'"\r\n]/.test(wrapper.replaceAll("{module}", "")))
    throw new CliError("wrapper contains shell metacharacters; use a script");
  const words = wrapper.trim().split(/\s+/).filter(Boolean);
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
async function resolveBinary(
  binary: Config["binary"],
): Promise<{ binary: "terraform" | "tofu"; fallbackReason?: string }> {
  if (binary !== "auto") return { binary };
  let terraformError: unknown;
  try {
    assertAllowed(versionArgs);
    await execute("terraform", versionArgs, { timeout: 2_000, killSignal: "SIGKILL", env: runEnv() });
    return { binary: "terraform" };
  } catch (error) {
    terraformError = error;
  }
  try {
    assertAllowed(versionArgs);
    await execute("tofu", versionArgs, { timeout: 2_000, killSignal: "SIGKILL", env: runEnv() });
    return { binary: "tofu", fallbackReason: `Terraform probe failed: ${classify(terraformError)}` };
  } catch (error) {
    const tofuFailure = classify(error);
    const terraformFailure = classify(terraformError);
    throw new CliError(
      tofuFailure === "not found" && terraformFailure !== "not found" ? terraformFailure : tofuFailure,
    );
  }
}

export type RunOptions = {
  /** Terraform arguments after the executable or wrapper. Defaults to `version -json`. */
  args?: string[];
  /** Non-zero exit codes that are results rather than failures, e.g. `-detailed-exitcode`'s 1 and 2. */
  exitCodes?: number[];
  maxBuffer?: number;
};
export type RunResult = { stdout: string; stderr: string; exitCode: number; fallbackReason?: string };

const operations = { state_list: ["state", "list"], show_state: ["show", "-json"] } as const;
export type Operation = keyof typeof operations;
export function runOperation(config: Config, module: string, operation: Operation, timeout = 600_000) {
  return run(config, module, timeout, { args: [...operations[operation]], maxBuffer: 64 * 1024 * 1024 });
}

export async function run(
  config: Config,
  module: string,
  timeout?: number,
  options: RunOptions = {},
): Promise<RunResult> {
  const args = options.args ?? versionArgs;
  assertAllowed(args);
  let file: string;
  let argv: string[];
  let fallbackReason: string | undefined;
  if (config.wrapper) [file, argv] = wrapperArgs(config.wrapper, module, args);
  else {
    const selected = await resolveBinary(config.binary);
    file = selected.binary;
    fallbackReason = selected.fallbackReason;
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
  const execOptions = {
    timeout: timeout ?? 10_000,
    killSignal: "SIGKILL" as const,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    env: runEnv(),
  };
  const accepted = (error: unknown): RunResult | undefined => {
    const record = error && typeof error === "object" ? error : {};
    if (!("code" in record) || typeof record.code !== "number" || !options.exitCodes?.includes(record.code))
      return undefined;
    const text = (key: string) =>
      key in record && typeof (record as Record<string, unknown>)[key] === "string"
        ? ((record as Record<string, unknown>)[key] as string)
        : "";
    return { stdout: text("stdout"), stderr: text("stderr"), exitCode: record.code };
  };
  try {
    assertAllowed(args);
    const result = await execute(file, argv, execOptions);
    return { ...result, exitCode: 0, ...(fallbackReason ? { fallbackReason } : {}) };
  } catch (error) {
    const result = accepted(error);
    if (result) return { ...result, ...(fallbackReason ? { fallbackReason } : {}) };
    let failure = error;
    if (
      !options.args &&
      !config.wrapper &&
      config.binary === "auto" &&
      file === "terraform" &&
      classify(error) !== "output limit exceeded"
    ) {
      try {
        assertAllowed(args);
        const result = await execute("tofu", argv, execOptions);
        return { ...result, exitCode: 0, fallbackReason: `Terraform invocation failed: ${classify(error)}` };
      } catch (tofuError) {
        const result = accepted(tofuError);
        if (result) return { ...result, fallbackReason: `Terraform invocation failed: ${classify(error)}` };
        failure = tofuError;
      }
    }
    const record = failure && typeof failure === "object" ? failure : {};
    const category = classify(failure);
    const stdout = "stdout" in record && typeof record.stdout === "string" ? record.stdout : "";
    const diagnostics =
      options.args?.[0] === "state" || options.args?.[0] === "show"
        ? []
        : parsePlanEvents(stdout).diagnostics.map(diagnosticMetadata);
    throw new CliError(category, 1, diagnostics);
  }
}
