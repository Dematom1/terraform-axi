import { readFileSync } from "node:fs";
import { commandLine, parseArgs } from "../args.js";
import type { Config } from "../config.js";
import { CliError, ReportError, UsageError } from "../errors.js";
import { run } from "../runner.js";
import { diagnosticMetadata, metadataAddress, reasonCode, parsePlanEvents, type PlanEvents } from "./events.js";
import { evaluateExpect, parseExpect, type ExpectedCounts } from "./expect.js";
import { classifyRisks } from "./risk.js";
import { parsePlanFile } from "./show.js";

/**
 * The exact plan argv. `-lock=false` keeps a read-only plan from writing a lock to the backend, and there is
 * no `-out`. With `-detailed-exitcode`, exit 2 means changes are present; only exit 1 is a failure.
 */
export const PLAN_ARGS = ["plan", "-json", "-input=false", "-lock=false", "-detailed-exitcode"];
const FAILED_EXIT = 1;
export const usage =
  "terraform-axi plan <module> [--expect add=N,change=N,destroy=N] [--binary terraform|tofu] [--timeout seconds] [--full] [--fields columns] | terraform-axi plan --plan-json <file> [--expect ...] [--full] [--fields columns]";
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const LOW_RISK_SHOWN = 25;
const FIELDS = ["address", "action", "type", "risk", "flags", "reason"] as const;
type Field = (typeof FIELDS)[number];
const isField = (value: string): value is Field => FIELDS.some((field) => field === value);

export function renderPlan(
  events: PlanEvents,
  options: {
    source: Record<string, string>;
    expected?: ExpectedCounts;
    full?: boolean;
    module?: string;
    fields?: Field[];
    invocation?: string;
    failed?: boolean;
  },
): { report: Record<string, unknown>; ok: boolean } {
  const errors = events.diagnostics.filter((d) => d.severity === "error");
  const risks = classifyRisks(events);
  const high = risks.filter((row) => row.level === "high");
  const low = risks.filter((row) => row.level === "low");
  const shownLow = options.full ? low : low.slice(0, LOW_RISK_SHOWN);
  const fields = options.fields ?? (options.full ? FIELDS : FIELDS.slice(0, 4));
  const rows = [...high, ...shownLow].map((row) => {
    const detail = {
      address: metadataAddress(row.address),
      action: row.action,
      type: row.type ?? "",
      risk: row.level,
      flags: row.flags.join(" "),
      reason: row.action === "unknown" ? "unrecognized action" : row.reason ? reasonCode(row.reason) : "",
    };
    return Object.fromEntries(fields.map((field) => [field, detail[field]]));
  });
  const report: Record<string, unknown> = { ...options.source };
  if (events.version)
    report.version = events.flavor === "unknown" ? events.version : `${events.flavor} ${events.version}`;
  // Malformed JSON events mean lost output; counted wrapper progress is not an event.
  const complete = events.summary !== "unavailable" && events.malformed === 0;
  report.status = errors.length || options.failed ? "error" : complete ? "planned" : "incomplete";
  report.summary = events.summary;
  report.risk = { high: high.length, low: low.length };
  report.changes = rows.length ? rows : "none";
  if (shownLow.length < low.length) report.low_risk_omitted = low.length - shownLow.length;
  if (events.drift.length)
    report.drift = events.drift.map((row) => ({
      address: metadataAddress(row.address),
      action: row.action,
      type: row.type ?? "",
    }));
  if (events.diagnostics.length) report.diagnostics = events.diagnostics.map(diagnosticMetadata);
  if (events.skippedWrapperOutput) report.skipped_wrapper_lines = events.skippedWrapperOutput;
  if (events.malformed) report.malformed_lines = events.malformed;
  if (events.unknownEvents) report.unknown_events = events.unknownEvents;
  let ok = errors.length === 0 && complete && !options.failed;
  if (options.expected) {
    const result = evaluateExpect(options.expected, events);
    report.expect = result.reasons.length
      ? { status: result.status, reasons: result.reasons }
      : { status: result.status };
    if (result.status === "fail") ok = false;
  }
  const help: string[] = [];
  const invocation =
    options.invocation ??
    commandLine([
      "plan",
      ...(options.source.plan_json ? ["--plan-json", options.source.plan_json] : [options.module ?? "<module>"]),
    ]);
  if (high.length && !options.fields && !options.full)
    help.push(`Run \`${invocation} --fields address,action,flags,reason\` to inspect high-risk detail`);
  if (shownLow.length < low.length) help.push(`Run \`${invocation} --full\` to list all ${risks.length} changes`);
  if (!complete || errors.length || options.failed)
    help.push(`Check the selected plan input and diagnostics, then rerun \`${invocation}\` before trusting these rows`);
  if (options.expected && complete && !errors.length && !options.failed && !ok)
    help.push(`Review the expectation mismatch before retrying \`${invocation}\``);
  if (!options.expected && !errors.length && complete && !options.failed)
    help.push(`Run \`${invocation} --expect add=N,change=N,destroy=N\` to assert the planned counts`);
  if (help.length) report.help = help;
  return { report, ok };
}

export async function planCommand(args: string[], config: Config): Promise<Record<string, unknown>> {
  const { module, planJson, expected, full, binary, timeout, fields, invocation } = parsePlanArgs(args);
  let events: PlanEvents;
  let source: Record<string, string>;
  let stderr = "";
  let stdout = "";
  let exitCode = 0;
  if (planJson) {
    let text: string;
    try {
      text = readFileSync(planJson, "utf8");
    } catch {
      throw new CliError(`cannot read plan file: ${planJson}`);
    }
    try {
      events = parsePlanFile(text);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    source = { plan_json: planJson };
  } else {
    // `--binary` runs that executable directly, bypassing any configured wrapper.
    const runConfig: Config = binary ? { binary, modules: config.modules } : config;
    const result = await run(runConfig, module!, timeout * 1000, {
      args: PLAN_ARGS,
      exitCodes: [1, 2],
      maxBuffer: 256 * 1024 * 1024,
    });
    stdout = result.stdout;
    events = parsePlanEvents(stdout, Boolean(runConfig.wrapper));
    source = { module: module! };
    if (runConfig.wrapper) source.via = "wrapper";
    if (result.fallbackReason) source.note = result.fallbackReason;
    stderr = result.stderr;
    exitCode = result.exitCode;
  }
  const rendered = renderPlan(events, {
    source,
    full,
    failed: exitCode === FAILED_EXIT,
    ...(fields ? { fields } : {}),
    invocation,
    ...(expected ? { expected } : {}),
    ...(module ? { module } : {}),
  });
  const { report } = rendered;
  // A failed exit is an error even when the stream looks complete.
  if (exitCode === FAILED_EXIT) {
    report.status = "error";
    report.exit_code = exitCode;
  }
  const ok = rendered.ok && exitCode !== FAILED_EXIT;
  if (!ok && stderr.trim()) report.stderr = { lines: stderr.trim().split(/\r?\n/).length, content: "withheld" };
  if (!ok && !events.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const lines = stdout.split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    if (lines.length) report.stdout = { lines: lines.length, content: "withheld" };
  }
  if (!ok) throw new ReportError(report);
  return report;
}

/** Parses plan arguments. `--full` is a bare switch. */
export function parsePlanArgs(args: string[]): {
  module?: string;
  planJson?: string;
  expected?: ExpectedCounts;
  full: boolean;
  binary?: "terraform" | "tofu";
  timeout: number;
  fields?: Field[];
  invocation: string;
} {
  const parsed = parseArgs(args, [
    { name: "--full", boolean: true },
    { name: "--fields" },
    { name: "--expect" },
    { name: "--plan-json" },
    { name: "--binary", values: ["terraform", "tofu"] },
    { name: "--timeout" },
  ]);
  const full = parsed.values["--full"] !== undefined;
  const requested = parsed.values["--fields"]?.[0]?.split(",");
  if (requested && !requested.every(isField))
    throw new UsageError(`--fields must be selected from ${FIELDS.join(",")}`);
  const fields = requested?.filter(isField);
  if (parsed.positional.length)
    throw new UsageError(`unexpected plan argument: ${parsed.positional[0]}; usage: ${usage}`);
  const module = parsed.command;
  const planJson = parsed.values["--plan-json"]?.[0];
  if (!module && !planJson) throw new UsageError(`plan needs a module or --plan-json <file>; usage: ${usage}`);
  if (module && planJson) throw new UsageError("give a module or --plan-json <file>, not both");
  const binary = parsed.values["--binary"]?.[0] as "terraform" | "tofu" | undefined;
  const timeoutText = parsed.values["--timeout"]?.[0];
  if (planJson && (binary || timeoutText)) throw new UsageError("--binary and --timeout apply only to plan <module>");
  const timeout = timeoutText === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(timeoutText);
  if (!/^\d+$/.test(timeoutText ?? "1") || !Number.isSafeInteger(timeout) || timeout < 1)
    throw new UsageError(`--timeout must be a whole number of seconds, got ${timeoutText}`);
  if (timeout > MAX_TIMEOUT_SECONDS) throw new UsageError(`--timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  let expected: ExpectedCounts | undefined;
  const spec = parsed.values["--expect"]?.[0];
  if (spec !== undefined) {
    try {
      expected = parseExpect(spec);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ...(module ? { module } : {}),
    ...(planJson ? { planJson } : {}),
    ...(expected ? { expected } : {}),
    ...(binary ? { binary } : {}),
    full,
    timeout,
    ...(fields ? { fields } : {}),
    invocation: commandLine([
      "plan",
      ...Object.entries(parsed.values).flatMap(([flag, values]) => (flag === "--full" ? [flag] : [flag, values[0]!])),
      ...(module ? [module] : []),
    ]),
  };
}
