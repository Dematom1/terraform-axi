import { resolve } from "node:path";
import { commandLine, parseArgs } from "../args.js";
import type { Config } from "../config.js";
import { ReportError, UsageError } from "../errors.js";
import { PLAN_ARGS } from "../plan/command.js";
import { diagnosticMetadata, metadataAddress, parsePlanEvents, type PlanChange } from "../plan/events.js";
import { run, wrapperArgs } from "../runner.js";

/** The plan argv plus `-refresh-only`: compares state with real infrastructure, never with configuration. */
export const DRIFT_ARGS = [...PLAN_ARGS, "-refresh-only"];
export const driftUsage = "terraform-axi drift <module> [--binary terraform|tofu]";
const MAX_ROWS = 20;
const TIMEOUT_MS = 600_000;

// Drift is reported in Terraform's own words: a resource deleted out of band is `delete`, not a planned DESTROY.
const DRIFT_ACTION: Partial<Record<PlanChange["action"], string>> = { DESTROY: "delete", REPLACE: "replace" };
const driftAction = (row: PlanChange) => DRIFT_ACTION[row.action] ?? row.action;
const shellWord = (word: string) => (/^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * Runs a refresh-only plan and reports drift. The drifted count comes from `resource_drift` events only:
 * `change_summary` stays 0/0/0 for a refresh-only plan even when resources drifted.
 */
export async function drift(args: string[], config: Config): Promise<Record<string, unknown>> {
  const parsed = parseArgs(args, [{ name: "--binary", values: ["terraform", "tofu"] }]);
  const module = parsed.command;
  if (module === undefined || parsed.positional.length)
    throw new UsageError(`expected exactly one module; usage: ${driftUsage}`);
  const binary = parsed.values["--binary"]?.[0] as "terraform" | "tofu" | undefined;
  // `--binary` runs that executable directly, bypassing any configured wrapper, as `plan` does.
  const runConfig: Config = binary ? { binary, modules: config.modules } : config;
  const invocation = commandLine(["drift", module, ...(binary ? ["--binary", binary] : [])]);
  const result = await run(runConfig, module, TIMEOUT_MS, {
    args: DRIFT_ARGS,
    exitCodes: [1, 2],
    maxBuffer: 256 * 1024 * 1024,
  });
  const events = parsePlanEvents(result.stdout, Boolean(runConfig.wrapper));
  const report: Record<string, unknown> = { module };
  if (runConfig.wrapper) report.via = "wrapper";
  if (result.fallbackReason) report.note = result.fallbackReason;
  if (events.version)
    report.version = events.flavor === "unknown" ? events.version : `${events.flavor} ${events.version}`;

  if (events.diagnostics.length) report.diagnostics = events.diagnostics.map(diagnosticMetadata);
  if (events.skippedWrapperOutput) report.skipped_wrapper_lines = events.skippedWrapperOutput;
  if (events.malformed) report.malformed_lines = events.malformed;
  const errors = events.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length || result.exitCode === 1) {
    report.status = "error";
    if (result.exitCode) report.exit_code = result.exitCode;
    if (result.stderr.trim())
      report.stderr = { lines: result.stderr.trim().split(/\r?\n/).length, content: "withheld" };
    report.help = [`Fix the reported errors, then rerun \`${invocation}\``];
    throw new ReportError(report);
  }
  // Malformed JSON events mean drift rows may be missing; wrapper progress is counted separately.
  if (events.summary === "unavailable" || events.malformed) {
    report.status = "incomplete";
    report.help = [`The plan output is incomplete; rerun \`${invocation}\` before trusting it`];
    throw new ReportError(report);
  }

  const rows = events.drift.map((row) => ({ action: driftAction(row), address: metadataAddress(row.address) }));
  report.status = rows.length ? "drift detected" : "no drift";
  report.drifted = rows.length;
  if (rows.length) {
    report.drift = rows.slice(0, MAX_ROWS);
    if (rows.length > MAX_ROWS) report.truncated = `showing ${MAX_ROWS} of ${rows.length}`;
    report.human_only = humanOnly(runConfig, module, events.flavor);
  }
  report.help = [
    `Run \`${commandLine(["plan", module, ...(binary ? ["--binary", binary] : [])])}\` to see planned configuration changes`,
    ...(rows.length ? ["A human may accept the drift into state with the human_only command; never run it"] : []),
  ];
  return report;
}

/** The exact command a human would run to accept drift into state, built like the drift invocation itself. */
function humanOnly(config: Config, module: string, flavor: "terraform" | "tofu" | "unknown"): string {
  const args = ["apply", "-refresh-only"];
  if (config.wrapper) {
    const [file, argv] = wrapperArgs(config.wrapper, module, args);
    return [file, ...argv].map(shellWord).join(" ");
  }
  const binary = flavor !== "unknown" ? flavor : config.binary === "auto" ? "terraform" : config.binary;
  return [binary, `-chdir=${resolve(module)}`, ...args].map(shellWord).join(" ");
}
