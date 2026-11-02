import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "../args.js";
import type { Config } from "../config.js";
import { ReportError, UsageError } from "../errors.js";
import { run } from "../runner.js";

const execute = promisify(execFile);
const TIMEOUT_MS = 60_000;
export const lintUsage = "terraform-axi lint <module> [--binary terraform|tofu]";
type Finding = { file: string | null; line: number | null; rule: string; severity: string; message: string };
type Check = { check: string; status: "passed" | "skipped" | "error"; reason: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid diagnostic output");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("invalid diagnostic text");
  return value;
};
function location(value: unknown): Pick<Finding, "file" | "line"> {
  if (value === undefined) return { file: null, line: null };
  const range = object(value);
  const start = object(range.start);
  if (typeof start.line !== "number" || !Number.isInteger(start.line) || start.line < 1)
    throw new Error("invalid diagnostic line");
  return { file: text(range.filename), line: start.line };
}
function diagnostics(stdout: string, tool: "validate" | "tflint"): Finding[] {
  const data = object(JSON.parse(stdout));
  const rows = tool === "validate" ? data.diagnostics : data.issues;
  if (!Array.isArray(rows)) throw new Error("missing diagnostics");
  if (tool === "tflint" && (!Array.isArray(data.errors) || data.errors.length))
    throw new Error("tflint reported execution errors");
  if (tool === "validate" && typeof data.valid !== "boolean") throw new Error("missing validation status");
  const findings = rows.map((row: unknown): Finding => {
    const d = object(row);
    const rule = tool === "tflint" ? object(d.rule) : undefined;
    const severity = text(rule ? rule.severity : d.severity);
    if (!(tool === "tflint" ? ["error", "warning", "info"] : ["error", "warning"]).includes(severity))
      throw new Error("invalid diagnostic severity");
    return {
      ...location(d.range),
      rule: rule ? text(rule.name) : "validate",
      severity,
      message: rule ? text(d.message) : [text(d.summary), text(d.detail)].filter(Boolean).join(": "),
    };
  });
  if (tool === "validate" && data.valid === false && !findings.some((f) => f.severity === "error"))
    throw new Error("validation failed without diagnostics");
  return findings;
}

export async function lint(args: string[], config: Config): Promise<Record<string, unknown>> {
  const parsed = parseArgs(args, [{ name: "--binary", values: ["terraform", "tofu"] }]);
  const module = parsed.command;
  if (!module || parsed.positional.length) throw new UsageError(`expected exactly one module; usage: ${lintUsage}`);
  const directory = resolve(module);
  try {
    if (!statSync(directory).isDirectory()) throw new Error();
  } catch {
    throw new UsageError(`module directory not found: ${module}`);
  }
  const binary = parsed.values["--binary"]?.[0];
  const settings: Config = binary === "terraform" || binary === "tofu" ? { binary, modules: config.modules } : config;
  const findings: Finding[] = [];
  const checks: Check[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    const start = findings.length;
    try {
      await action();
    } catch (error) {
      findings.push({
        file: null,
        line: null,
        rule: name,
        severity: "error",
        message: error instanceof Error ? error.message : "check failed",
      });
    }
    checks.push({
      check: name,
      status: findings.slice(start).some((f) => f.severity === "error") ? "error" : "passed",
      reason: "",
    });
  };
  await check("fmt", async () => {
    const result = await run(settings, module, TIMEOUT_MS, {
      args: ["fmt", "-check", "-no-color"],
      exitCodes: [1, 2, 3],
    });
    if (result.exitCode === 3) {
      const files = result.stdout.trim().split("\n").filter(Boolean);
      if (!files.length) throw new Error("format check failed without filenames");
      findings.push(
        ...files.map((file) => ({
          file,
          line: null,
          rule: "fmt",
          severity: "error",
          message: "File is not formatted",
        })),
      );
    } else if (result.exitCode) throw new Error("Format check failed; fix configuration syntax and rerun lint");
  });
  // Conservatively require the data directory; never initialize to make validation possible.
  let initialized = false;
  try {
    initialized = statSync(resolve(directory, process.env.TF_DATA_DIR || ".terraform")).isDirectory();
  } catch {
    /* not initialized */
  }
  if (initialized)
    await check("validate", async () => {
      const result = await run(settings, module, TIMEOUT_MS, {
        args: ["validate", "-json", "-no-color"],
        exitCodes: [1],
      });
      const rows = diagnostics(result.stdout, "validate");
      findings.push(...rows);
      if (result.exitCode && !rows.some((f) => f.severity === "error"))
        throw new Error("validate failed without an error diagnostic");
    });
  else
    checks.push({
      check: "validate",
      status: "skipped",
      reason: "Module is not initialized (data directory absent); lint never runs init",
    });
  let tflintMissing = false;
  await check("tflint", async () => {
    let stdout: string;
    let exitCode = 0;
    try {
      ({ stdout } = await execute("tflint", ["--format=json"], {
        cwd: directory,
        timeout: TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ENOENT") {
          tflintMissing = true;
          return;
        }
        if (error.code === 2 && "stdout" in error && typeof error.stdout === "string") {
          stdout = error.stdout;
          exitCode = 2;
        } else throw new Error("tflint failed, timed out, or exceeded its output limit");
      } else throw new Error("tflint failed");
    }
    const rows = diagnostics(stdout, "tflint");
    findings.push(...rows);
    if (exitCode && !rows.length) throw new Error("tflint failed without findings");
  });
  if (tflintMissing)
    checks[checks.length - 1] = { check: "tflint", status: "skipped", reason: "tflint is not installed" };
  const report = {
    module,
    status: findings.some((f) => f.severity === "error") ? "error" : "ok",
    checks,
    count: findings.length,
    findings,
  };
  if (report.status === "error") throw new ReportError(report);
  return report;
}
