import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../args.js";
import type { Config } from "../config.js";
import { CliError, ReportError, UsageError } from "../errors.js";
import { run } from "../runner.js";
import { parsePlanEvents, type PlanEvents } from "./events.js";
import { evaluateExpect, parseExpect, type ExpectedCounts } from "./expect.js";
import { classifyRisks } from "./risk.js";
import { parsePlanFile } from "./show.js";

/**
 * The exact plan argv. `-lock=false` keeps a read-only plan from writing a lock to the backend, and there is
 * no `-out`. No `-detailed-exitcode`: the stream's change_summary already says whether anything changes, and
 * a wrapper may remap exit code 2, so only exit code 1 (failure) is meaningful.
 */
export const PLAN_ARGS = ["plan", "-json", "-input=false", "-lock=false"];
export const usage =
  "terraform-axi plan <module> [--expect add=N,change=N,destroy=N] [--all] | terraform-axi plan --plan-json <file> [--expect ...] [--all]";
const PLAN_TIMEOUT_MS = 30 * 60_000;
const LOW_RISK_SHOWN = 25;
const DETAIL_CHARS = 300;

const SECRET_ENV = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY|ACCESS_KEY|APPLICATION_KEY/i;
/** Masks values of credential-like environment variables in any text copied from Terraform output. */
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const [key, value] of Object.entries(env))
    if (value && value.length >= 6 && SECRET_ENV.test(key)) result = result.split(value).join("[redacted]");
  return result;
}
const clip = (text: string) => (text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text);
const shellWord = (word: string) => (/^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** The command a human would run to apply. terraform-axi only prints it. */
function applyCommand(config: Config, module: string, events: PlanEvents): string {
  if (config.wrapper)
    return [
      ...config.wrapper
        .trim()
        .split(/\s+/)
        .map((w) => (w === "{module}" ? module : w)),
      "apply",
    ]
      .map(shellWord)
      .join(" ");
  const binary = events.flavor !== "unknown" ? events.flavor : config.binary === "auto" ? "terraform" : config.binary;
  return [binary, `-chdir=${resolve(module)}`, "apply"].map(shellWord).join(" ");
}

export function renderPlan(
  events: PlanEvents,
  options: {
    source: Record<string, string>;
    expected?: ExpectedCounts;
    all?: boolean;
    apply?: string;
    module?: string;
  },
): { report: Record<string, unknown>; ok: boolean } {
  const errors = events.diagnostics.filter((d) => d.severity === "error");
  const risks = classifyRisks(events);
  const high = risks.filter((row) => row.level === "high");
  const low = risks.filter((row) => row.level === "low");
  const shownLow = options.all ? low : low.slice(0, LOW_RISK_SHOWN);
  const rows = [...high, ...shownLow].map((row) => ({
    address: row.address,
    action: row.action,
    type: row.type ?? "",
    risk: row.level,
    flags: row.flags.join(" "),
    reason: row.action === "unknown" ? `unrecognized action ${row.raw ?? ""}` : (row.reason ?? ""),
  }));
  const report: Record<string, unknown> = { ...options.source };
  if (events.version)
    report.version = events.flavor === "unknown" ? events.version : `${events.flavor} ${events.version}`;
  // A line that is not a JSON event means lost output (a killed or truncated plan), so nothing is trusted.
  const complete = events.summary !== "unavailable" && events.malformed === 0;
  report.status = errors.length ? "error" : complete ? "planned" : "incomplete";
  report.summary = events.summary;
  report.risk = { high: high.length, low: low.length };
  report.changes = rows.length ? rows : "none";
  if (shownLow.length < low.length) report.low_risk_omitted = low.length - shownLow.length;
  if (events.drift.length)
    report.drift = events.drift.map((row) => ({ address: row.address, action: row.action, type: row.type ?? "" }));
  if (events.diagnostics.length)
    report.diagnostics = events.diagnostics.map((d) => ({
      severity: d.severity,
      summary: clip(scrub(d.summary)),
      address: d.address ?? "",
      detail: d.severity === "error" && d.detail ? clip(scrub(d.detail)) : "",
    }));
  if (events.malformed) report.malformed_lines = events.malformed;
  if (events.unknownEvents) report.unknown_events = events.unknownEvents;
  let ok = errors.length === 0 && complete;
  if (options.expected) {
    const result = evaluateExpect(options.expected, events);
    report.expect = result.reasons.length
      ? { status: result.status, reasons: result.reasons }
      : { status: result.status };
    if (result.status === "fail") ok = false;
  }
  const help: string[] = [];
  if (high.length) help.push("Review high-risk rows (destroy, replace, iam, secret, unknown) before anyone applies");
  if (shownLow.length < low.length && options.module)
    help.push(`Run \`terraform-axi plan ${shellWord(options.module)} --all\` to list every change`);
  if (options.apply && risks.length && !errors.length)
    help.push(`terraform-axi never applies; a human may run: \`${options.apply}\``);
  if (!complete && !errors.length)
    help.push("The plan output is incomplete; rerun the plan before trusting these rows");
  if (!options.expected && !errors.length && complete)
    help.push("Add `--expect add=N,change=N,destroy=N` to assert the planned counts");
  if (help.length) report.help = help;
  return { report, ok };
}

export async function planCommand(args: string[], config: Config): Promise<Record<string, unknown>> {
  const { module, planJson, expected, all } = parsePlanArgs(args);
  let events: PlanEvents;
  let source: Record<string, string>;
  let apply: string | undefined;
  let stderr = "";
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
    const result = await run(config, module!, PLAN_TIMEOUT_MS, {
      args: PLAN_ARGS,
      exitCodes: [1],
      maxBuffer: 256 * 1024 * 1024,
    });
    events = parsePlanEvents(result.stdout);
    source = { module: module! };
    if (config.wrapper) source.via = "wrapper";
    if (result.fallbackReason) source.note = result.fallbackReason;
    apply = applyCommand(config, module!, events);
    stderr = result.stderr;
    exitCode = result.exitCode;
  }
  const rendered = renderPlan(events, {
    source,
    all,
    ...(expected ? { expected } : {}),
    ...(apply ? { apply } : {}),
    ...(module ? { module } : {}),
  });
  const { report } = rendered;
  // A failed exit is an error even when the stream looks complete.
  if (exitCode !== 0 && report.status !== "error") {
    report.status = "error";
    report.exit_code = exitCode;
  }
  const ok = rendered.ok && exitCode === 0;
  if (!ok && stderr.trim())
    report.stderr = stderr
      .trim()
      .split("\n")
      .slice(-5)
      .map((line) => clip(scrub(line)));
  if (!ok) throw new ReportError(report);
  return report;
}

/** Parses plan arguments. `--all` is a bare switch. */
export function parsePlanArgs(args: string[]): {
  module?: string;
  planJson?: string;
  expected?: ExpectedCounts;
  all: boolean;
} {
  const all = args.includes("--all");
  const parsed = parseArgs(
    args.filter((arg) => arg !== "--all"),
    [{ name: "--expect" }, { name: "--plan-json" }],
  );
  if (parsed.positional.length)
    throw new UsageError(`unexpected plan argument: ${parsed.positional[0]}; usage: ${usage}`);
  const module = parsed.command;
  const planJson = parsed.values["--plan-json"]?.[0];
  if (!module && !planJson) throw new UsageError(`plan needs a module or --plan-json <file>; usage: ${usage}`);
  if (module && planJson) throw new UsageError("give a module or --plan-json <file>, not both");
  let expected: ExpectedCounts | undefined;
  const spec = parsed.values["--expect"]?.[0];
  if (spec !== undefined) {
    try {
      expected = parseExpect(spec);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  return { ...(module ? { module } : {}), ...(planJson ? { planJson } : {}), ...(expected ? { expected } : {}), all };
}
