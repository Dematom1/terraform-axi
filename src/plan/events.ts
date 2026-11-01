/**
 * Decodes the JSONL stream of `terraform|tofu plan -json` into typed plan events.
 *
 * The stream contract was captured from Terraform 1.15.8 and OpenTofu 1.13.1 (see test/fixtures/plan):
 * `planned_change` and `resource_drift` carry `change.resource.addr`, a singular `change.action`, and
 * `change.reason`. `show -json` documents use a plural `actions` array instead, so both forms decode here.
 */

/** Display action. `unknown` is any action value this decoder does not recognize; its raw value is kept. */
export type PlanAction =
  "create" | "update" | "REPLACE" | "DESTROY" | "read" | "move" | "import" | "forget" | "unknown";
export type PlanChange = { address: string; action: PlanAction; type?: string; reason?: string; raw?: string };
export type PlanOutput = { name: string; action: PlanAction | "noop"; sensitive: boolean; raw?: string };
export type PlanSummary = { add: number; change: number; destroy: number; import?: number; forget?: number };
export type PlanDiagnostic = { severity: string; summary: string; detail?: string; address?: string };
export type PlanEvents = {
  flavor: "terraform" | "tofu" | "unknown";
  version?: string;
  changes: PlanChange[];
  drift: PlanChange[];
  /** `unavailable` when the stream has no valid `change_summary`. Never a guessed zero. */
  summary: PlanSummary | "unavailable";
  outputs: PlanOutput[];
  diagnostics: PlanDiagnostic[];
  /** Lines that are not a JSON event object. Only the count is kept, never the content. */
  malformed: number;
  /** Well-formed events of a type this decoder does not know. */
  unknownEvents: number;
};

type Decoded = { action: PlanAction | "noop"; raw?: string };
type Json = Record<string, unknown>;

// Streaming `plan -json` names forget `remove`; `show -json` names it `forget`. Neither is a destroy.
const SINGLE = new Map<string, PlanAction | "noop">([
  ["noop", "noop"],
  ["no-op", "noop"],
  ["create", "create"],
  ["update", "update"],
  ["delete", "DESTROY"],
  ["replace", "REPLACE"],
  ["read", "read"],
  ["move", "move"],
  ["import", "import"],
  ["remove", "forget"],
  ["forget", "forget"],
]);
// Progress events that carry nothing a plan summary needs.
const PROGRESS = /^(?:log|refresh_start|refresh_complete|apply_\w+|provision_\w+|ephemeral_\w+|action_\w+)$/;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function rawText(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "missing" : JSON.stringify(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

/**
 * Decodes a singular `action` string or a plural `actions` array. Any array containing both `create` and
 * `delete` is a replace; extra values are kept raw. Other unrecognized values stay visible as `unknown`.
 */
export function decodeAction(change: Json): Decoded {
  const value = "action" in change ? change.action : change.actions;
  const parts: unknown[] = Array.isArray(value) ? value : [value];
  if (parts.length === 1) {
    const action = typeof parts[0] === "string" ? SINGLE.get(parts[0]) : undefined;
    if (action) return { action };
  } else if (parts.includes("create") && parts.includes("delete")) {
    return parts.length === 2
      ? { action: "REPLACE" }
      : { action: "REPLACE", raw: rawText(value) };
  }
  return { action: "unknown", raw: rawText(value) };
}

function decodeChange(event: Json): PlanChange | undefined {
  const change = isRecord(event.change) ? event.change : {};
  const resource = isRecord(change.resource) ? change.resource : {};
  const address = str(resource.addr);
  if (!address) return undefined;
  const { action, raw } = decodeAction(change);
  if (action === "noop") return undefined;
  const row: PlanChange = { address, action };
  const type = str(resource.resource_type);
  if (type) row.type = type;
  const reason = str(change.reason) ?? str(change.action_reason);
  if (reason) row.reason = reason;
  if (raw !== undefined) row.raw = raw;
  return row;
}

function decodeSummary(changes: unknown): PlanSummary | "unavailable" {
  if (!isRecord(changes)) return "unavailable";
  const add = count(changes.add);
  const change = count(changes.change);
  const destroy = count(changes.remove);
  if (add === undefined || change === undefined || destroy === undefined) return "unavailable";
  const summary: PlanSummary = { add, change, destroy };
  for (const key of ["import", "forget"] as const) {
    if (!(key in changes)) continue;
    const value = count(changes[key]);
    if (value === undefined) return "unavailable";
    summary[key] = value;
  }
  return summary;
}

export function parsePlanEvents(jsonl: string): PlanEvents {
  const result: PlanEvents = {
    flavor: "unknown",
    changes: [],
    drift: [],
    summary: "unavailable",
    outputs: [],
    diagnostics: [],
    malformed: 0,
    unknownEvents: 0,
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      result.malformed++;
      continue;
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      result.malformed++;
      continue;
    }
    switch (event.type) {
      case "version": {
        const tofu = str(event.tofu);
        const terraform = str(event.terraform);
        if (tofu) [result.flavor, result.version] = ["tofu", tofu];
        else if (terraform) [result.flavor, result.version] = ["terraform", terraform];
        break;
      }
      case "planned_change":
      case "resource_drift": {
        const row = decodeChange(event);
        if (row) (event.type === "planned_change" ? result.changes : result.drift).push(row);
        break;
      }
      case "change_summary":
        result.summary = decodeSummary(event.changes);
        break;
      case "outputs":
        if (!isRecord(event.outputs)) break;
        for (const [name, output] of Object.entries(event.outputs)) {
          if (!isRecord(output)) continue;
          const { action, raw } = decodeAction(isRecord(output.change) ? output.change : output);
          const row: PlanOutput = { name, action, sensitive: output.sensitive === true };
          if (raw !== undefined) row.raw = raw;
          result.outputs.push(row);
        }
        break;
      case "diagnostic": {
        const diagnostic = isRecord(event.diagnostic) ? event.diagnostic : {};
        const row: PlanDiagnostic = {
          severity: str(diagnostic.severity) ?? str(event["@level"]) ?? "unknown",
          summary: str(diagnostic.summary) ?? str(event["@message"]) ?? "",
        };
        const detail = str(diagnostic.detail);
        if (detail) row.detail = detail;
        const address = str(diagnostic.address);
        if (address) row.address = address;
        result.diagnostics.push(row);
        break;
      }
      default:
        if (!PROGRESS.test(event.type)) result.unknownEvents++;
    }
  }
  return result;
}
