/**
 * Decodes a saved plan for `plan --plan-json <file>`: either a `show -json` plan document or a
 * `plan -json` event stream. Only addresses, types, actions, and reasons are read; attribute values
 * (which hold secrets in plain text in a `show -json` document) are never copied out.
 */
import { decodeAction, parsePlanEvents, type PlanChange, type PlanEvents, type PlanOutput } from "./events.js";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// `show -json` spells replace reasons differently from the stream; use the stream's words everywhere.
const REASONS: Record<string, string> = {
  replace_because_cannot_update: "cannot_update",
  replace_because_tainted: "tainted",
  replace_by_request: "requested",
  replace_by_triggers: "replace_triggered_by",
};

function decodeResource(entry: unknown): PlanChange | undefined {
  if (!isRecord(entry) || !isRecord(entry.change)) return undefined;
  const address = str(entry.address);
  if (!address) return undefined;
  const decoded = decodeAction(entry.change);
  const raw = decoded.raw;
  let action = decoded.action;
  // The stream reports an import-only or move-only resource as its own action; the document says no-op.
  if (action === "noop") {
    if (entry.change.importing !== undefined) action = "import";
    else if (str(entry.previous_address)) action = "move";
    else return undefined;
  }
  const row: PlanChange = { address, action };
  const type = str(entry.type);
  if (type) row.type = type;
  const reason = str(entry.action_reason);
  if (reason) row.reason = REASONS[reason] ?? reason;
  if (raw !== undefined) row.raw = raw;
  return row;
}

/** Converts a `show -json` plan document into the same shape `parsePlanEvents` returns. */
export function parseShowDocument(doc: Json): PlanEvents {
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  let malformed = 0;
  const rows = (value: unknown) => {
    if (value !== undefined && !Array.isArray(value)) {
      malformed++;
      return [];
    }
    return list(value).flatMap((entry) => {
      if (
        !isRecord(entry) ||
        !str(entry.address) ||
        !isRecord(entry.change) ||
        !Array.isArray(entry.change.actions)
      ) {
        malformed++;
        return [];
      }
      const row = decodeResource(entry);
      if (!row) {
        if (decodeAction(entry.change).action !== "noop") malformed++;
        return [];
      }
      if (row.action === "unknown") malformed++;
      return [row];
    });
  };
  const changes = rows(doc.resource_changes);
  const drift = rows(doc.resource_drift);
  const outputChanges = doc.output_changes;
  const outputs: PlanOutput[] = isRecord(outputChanges)
    ? Object.entries(outputChanges).flatMap(([name, change]) => {
        if (!isRecord(change) || !Array.isArray(change.actions)) {
          malformed++;
          return [];
        }
        const { action, raw } = decodeAction(change);
        const row: PlanOutput = {
          name,
          action,
          sensitive: change.before_sensitive === true || change.after_sensitive === true,
        };
        if (raw !== undefined) row.raw = raw;
        return [row];
      })
    : outputChanges === undefined
      ? []
      : (malformed++, []);
  const tally = (...actions: string[]) => changes.filter((row) => actions.includes(row.action)).length;
  const imports = list(doc.resource_changes).filter(
    (entry) => isRecord(entry) && isRecord(entry.change) && entry.change.importing !== undefined,
  ).length;
  // A document has no summary of its own. Counting rows matches Terraform's summary for a complete plan
  // (an empty plan omits `resource_changes`). An errored plan, or one with an action this decoder cannot
  // count, gets none rather than a guessed number.
  const summary =
    doc.errored === true ||
    malformed > 0 ||
    changes.some((row) => row.action === "unknown") ||
    outputs.some((row) => row.action === "unknown")
      ? ("unavailable" as const)
      : {
          add: tally("create", "REPLACE"),
          change: tally("update"),
          destroy: tally("DESTROY", "REPLACE"),
          ...(imports ? { import: imports } : {}),
          ...(tally("forget") ? { forget: tally("forget") } : {}),
        };
  const version = str(doc.terraform_version);
  return {
    flavor: "unknown",
    ...(version ? { version } : {}),
    changes,
    drift,
    summary,
    outputs,
    diagnostics: [],
    malformed,
    unknownEvents: 0,
  };
}

/** Accepts a whole `show -json` document or a `plan -json` event stream. */
export function parsePlanFile(text: string): PlanEvents {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return parsePlanEvents(text);
  }
  if (!isRecord(doc)) throw new Error("not a Terraform plan: expected `show -json <planfile>` or `plan -json` output");
  if (typeof doc.type !== "string") {
    // A state document from `show -json` has `values` but no `planned_values`.
    if (!isRecord(doc.planned_values))
      throw new Error("not a Terraform plan: expected `show -json <planfile>` or `plan -json` output");
    return parseShowDocument(doc);
  }
  return parsePlanEvents(text);
}
