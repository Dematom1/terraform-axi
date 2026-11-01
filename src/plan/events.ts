export type PlanAction = "create" | "update" | "REPLACE" | "DESTROY" | "read" | "move" | "import" | "forget" | (string & {});
export type PlanChange = { address: string; action: PlanAction; reason?: string; type?: string };
export type PlanOutput = { name: string; action: string; sensitive: boolean };
export type PlanEvents = {
  flavor: "terraform" | "tofu" | "unknown";
  version?: string;
  changes: PlanChange[];
  drift: PlanChange[];
  summary: Record<string, number> | "unavailable";
  outputs: PlanOutput[];
  diagnostics: unknown[];
  malformed: number;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parsePlanEvents(jsonl: string): PlanEvents {
  const result: PlanEvents = {
    flavor: "unknown",
    changes: [],
    drift: [],
    summary: "unavailable",
    outputs: [],
    diagnostics: [],
    malformed: 0,
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      result.malformed++;
      continue;
    }
    if (!record(value) || typeof value.type !== "string") continue;
    if (value.type === "version") {
      if (
        typeof value.terraform_version === "string" ||
        (typeof value.terraform === "string" && value.terraform.startsWith("1."))
      ) {
        result.flavor = "terraform";
        result.version =
          typeof value.terraform_version === "string" ? value.terraform_version : String(value.terraform);
      } else if (
        typeof value.tofu_version === "string" ||
        (typeof value.terraform === "string" && value.terraform.startsWith("OpenTofu"))
      ) {
        result.flavor = "tofu";
        result.version = typeof value.tofu_version === "string" ? value.tofu_version : String(value.terraform);
      }
    } else if (value.type === "planned_change" || value.type === "resource_drift") {
      const resource = record(value.change) ? value.change : value;
      const detail = record(resource.resource) ? resource.resource : resource;
      const address =
        typeof detail.address === "string" ? detail.address : typeof detail.addr === "string" ? detail.addr : "";
      const actions =
        record(resource.change) && Array.isArray(resource.change.actions)
          ? resource.change.actions
          : Array.isArray(resource.actions)
            ? resource.actions
            : [];
      const action = typeof resource.action === "string" ? actionName(resource.action) : actionFor(actions);
      if (address && action) {
        const row: PlanChange = { address, action };
        if (typeof detail.type === "string") row.type = detail.type;
        else if (typeof detail.resource_type === "string") row.type = detail.resource_type;
        const reason = record(resource.change) ? resource.change.action_reason : resource.action_reason;
        if (typeof reason === "string") row.reason = reason;
        (value.type === "resource_drift" ? result.drift : result.changes).push(row);
      }
    } else if (value.type === "change_summary" && record(value.changes)) {
      const changes = value.changes;
      const add = changes.add;
      const change = changes.change;
      const destroy = changes.destroy ?? changes.remove;
      if (
        typeof add === "number" && Number.isInteger(add) && add >= 0 &&
        typeof change === "number" && Number.isInteger(change) && change >= 0 &&
        typeof destroy === "number" && Number.isInteger(destroy) && destroy >= 0
      ) result.summary = { add, change, destroy };
    } else if (value.type === "outputs" && record(value.outputs)) {
      for (const [name, raw] of Object.entries(value.outputs)) {
        if (!record(raw)) continue;
        const change = record(raw.change) ? raw.change : raw;
        const actions = Array.isArray(change.actions) ? change.actions : [];
        const action =
          typeof change.action === "string" ? actionName(change.action) : actionFor(actions);
        result.outputs.push({ name, action: action ?? "noop", sensitive: raw.sensitive === true });
      }
    } else if (value.type === "diagnostic") result.diagnostics.push(value);
  }
  return result;
}

function actionName(action: string): PlanAction | undefined {
  if (action === "no-op") return undefined;
  if (action === "create") return "create";
  if (action === "update") return "update";
  if (action === "delete" || action === "remove") return "DESTROY";
  if (action === "replace") return "REPLACE";
  if (action === "read") return "read";
  if (action === "forget") return "forget";
  if (action === "move") return "move";
  if (action === "import") return "import";
  return action;
}

function actionFor(actions: unknown[]): PlanAction | undefined {
  if (actions.includes("delete") && actions.includes("create")) return "REPLACE";
  const first = actions[0];
  if (first === "create") return "create";
  if (first === "update") return "update";
  if (first === "delete") return "DESTROY";
  if (first === "read") return "read";
  if (first === "no-op") return undefined;
  if (first === "forget") return "forget";
  if (first === "move") return "move";
  if (first === "import") return "import";
  return typeof first === "string" ? first : undefined;
}
