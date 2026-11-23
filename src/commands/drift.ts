import { resolve } from "node:path";
import { commandLine, parseArgs, shellWord } from "../args.js";
import type { Config } from "../config.js";
import { ReportError, UsageError } from "../errors.js";
import { PLAN_ARGS } from "../plan/command.js";
import {
  diagnosticMetadata,
  metadataAddress,
  parsePlanEvents,
  type PlanChange,
  type PlanEvents,
} from "../plan/events.js";
import { readPlanFile } from "../plan/show.js";
import { run, wrapperArgs, RUNNER_OPTIONS, selectRunConfig } from "../runner.js";

/** The plan argv plus `-refresh-only`: compares state with real infrastructure, never with configuration. */
export const DRIFT_ARGS = [...PLAN_ARGS, "-refresh-only"];
export const driftUsage =
  "terraform-axi drift <module> [--binary terraform|tofu|--wrapper command] [--full] | terraform-axi drift --plan-json <file> [--full]";
const MAX_ROWS = 20;
const TIMEOUT_MS = 600_000;

// Drift is reported in Terraform's own words: a resource deleted out of band is `delete`, not a planned DESTROY.
const DRIFT_ACTION: Partial<Record<PlanChange["action"], string>> = { DESTROY: "delete", REPLACE: "replace" };
const driftAction = (row: PlanChange) => DRIFT_ACTION[row.action] ?? row.action;

/**
 * Runs a refresh-only plan and reports drift. The drifted count comes from `resource_drift` events only:
 * `change_summary` stays 0/0/0 for a refresh-only plan even when resources drifted.
 */
export async function drift(args: string[], config: Config): Promise<Record<string, unknown>> {
  const parsed = parseArgs(args, [...RUNNER_OPTIONS, { name: "--plan-json" }, { name: "--full", boolean: true }]);
  const full = parsed.values["--full"] !== undefined;
  const module = parsed.command;
  const planJson = parsed.values["--plan-json"]?.[0];
  if (parsed.positional.length || (!module && !planJson) || (module && planJson))
    throw new UsageError(`expected exactly one module or --plan-json <file>; usage: ${driftUsage}`);
  const binary = parsed.values["--binary"]?.[0];
  const wrapper = parsed.values["--wrapper"]?.[0];
  if (planJson && (binary || wrapper)) throw new UsageError("--binary and --wrapper apply only to drift <module>");
  const input = planJson ? ["--plan-json", planJson] : [module!];
  const selectors = [...(binary ? ["--binary", binary] : []), ...(wrapper ? ["--wrapper", wrapper] : [])];
  const options = {
    full,
    invocation: commandLine(["drift", ...input, ...selectors, ...(full ? ["--full"] : [])]),
    planInvocation: commandLine(["plan", ...input, ...selectors]),
  };
  if (planJson) return renderDrift(readPlanFile(planJson), { ...options, source: { plan_json: planJson } });
  const runConfig = selectRunConfig(config, parsed.values);
  const result = await run(runConfig, module!, TIMEOUT_MS, {
    args: DRIFT_ARGS,
    exitCodes: [1, 2],
    maxBuffer: 256 * 1024 * 1024,
  });
  const events = parsePlanEvents(result.stdout, Boolean(runConfig.wrapper));
  return renderDrift(events, {
    ...options,
    source: {
      module: module!,
      ...(runConfig.wrapper ? { via: "wrapper" } : {}),
      ...(result.fallbackReason ? { note: result.fallbackReason } : {}),
    },
    exitCode: result.exitCode,
    stderr: result.stderr,
    humanOnly: humanOnly(runConfig, module!, events.flavor),
  });
}

function renderDrift(
  events: PlanEvents,
  {
    source,
    full,
    invocation,
    planInvocation,
    exitCode = 0,
    stderr = "",
    humanOnly,
  }: {
    source: Record<string, string>;
    full: boolean;
    invocation: string;
    planInvocation: string;
    exitCode?: number;
    stderr?: string;
    humanOnly?: string;
  },
): Record<string, unknown> {
  const report: Record<string, unknown> = { ...source };
  if (events.version)
    report.version = events.flavor === "unknown" ? events.version : `${events.flavor} ${events.version}`;
  if (events.unrecognizedTypes) report.unrecognized_types = events.unrecognizedTypes;
  if (events.unrecognizedVersions) report.unrecognized_versions = events.unrecognizedVersions;

  if (events.diagnostics.length) report.diagnostics = events.diagnostics.map(diagnosticMetadata);
  if (events.skippedWrapperOutput) report.skipped_wrapper_lines = events.skippedWrapperOutput;
  if (events.malformed) report.malformed_lines = events.malformed;
  const errors = events.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length || exitCode === 1) {
    report.status = "error";
    if (exitCode) report.exit_code = exitCode;
    if (stderr.trim()) report.stderr = { lines: stderr.trim().split(/\r?\n/).length, content: "withheld" };
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
  const truncated = !full && rows.length > MAX_ROWS;
  if (rows.length) {
    report.drift = full ? rows : rows.slice(0, MAX_ROWS);
    if (truncated) report.truncated = `showing ${MAX_ROWS} of ${rows.length}`;
    if (humanOnly) report.human_only = humanOnly;
  }
  report.help = [
    ...(truncated ? [`Run \`${invocation} --full\` to list all ${rows.length} drifted resources`] : []),
    `Run \`${planInvocation}\` to see planned configuration changes`,
    ...(rows.length && humanOnly
      ? ["A human may accept the drift into state with the human_only command; never run it"]
      : []),
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
