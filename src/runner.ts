import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "./errors.js";
import type { Config } from "./config.js";

const execute = promisify(execFile);
const versionArgs = ["version", "-json"];
const runEnv = () => ({ ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1" });
function classify(error: unknown): "not found" | "not executable" | "timeout" | "failed" {
  const record = error && typeof error === "object" ? error : {};
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

export async function run(
  config: Config,
  module: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string; fallbackReason?: string }> {
  assertAllowed(versionArgs);
  let file: string;
  let argv: string[];
  let fallbackReason: string | undefined;
  if (config.wrapper) [file, argv] = wrapperArgs(config.wrapper, module, versionArgs);
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
      argv = [`-chdir=${directory}`, ...versionArgs];
    } else argv = versionArgs;
  }
  try {
    assertAllowed(versionArgs);
    const result = await execute(file, argv, {
      timeout: timeout ?? 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      env: runEnv(),
    });
    return { ...result, ...(fallbackReason ? { fallbackReason } : {}) };
  } catch (error) {
    let failure = error;
    if (!config.wrapper && config.binary === "auto" && file === "terraform") {
      try {
        assertAllowed(versionArgs);
        const result = await execute("tofu", argv, {
          timeout: timeout ?? 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          env: runEnv(),
        });
        return { ...result, fallbackReason: `Terraform invocation failed: ${classify(error)}` };
      } catch (tofuError) {
        failure = tofuError;
      }
    }
    const record = failure && typeof failure === "object" ? failure : {};
    const category = classify(failure);
    const stdout = "stdout" in record && typeof record.stdout === "string" ? record.stdout : "";
    const diagnostics = stdout.split("\n").flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line);
        return event && typeof event === "object" && "type" in event && event.type === "diagnostic" ? [event] : [];
      } catch {
        return [];
      }
    });
    throw new CliError(category, 1, diagnostics);
  }
}
