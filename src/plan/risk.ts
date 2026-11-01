import type { PlanAction, PlanChange, PlanEvents } from "./events.js";

export type RiskFlag = "destroy" | `replace(${string})` | "iam" | "secret" | "unknown";
export type RiskRow = PlanChange & { flags: RiskFlag[]; level: "high" | "low" };

// ponytail: type-name tables miss custom or unknown providers; attribute-level detection via `show -json` is the upgrade path.
// `*` matches any run of characters, including none.
export const IAM_TYPES = [
  "aws_iam_*",
  "google_*_iam_*",
  "google_project_iam_*",
  "azurerm_role_assignment",
  "azurerm_role_definition",
  "kubernetes_*role*",
  "github_*_permission*",
];
export const SECRET_TYPES = [
  "aws_secretsmanager_*",
  "aws_ssm_parameter",
  "aws_iam_access_key",
  "aws_kms_*",
  "vault_*",
  "kubernetes_secret*",
  "google_secret_manager_*",
  "azurerm_key_vault_*",
  "random_password",
  "tls_private_key",
  "b2_application_key",
  "github_actions_*secret*",
];

const matcher = (patterns: string[]) => {
  const regex = new RegExp(`^(?:${patterns.map((p) => p.split("*").join(".*")).join("|")})$`);
  return (type: string) => regex.test(type);
};
export const isIamType = matcher(IAM_TYPES);
export const isSecretType = matcher(SECRET_TYPES);

/**
 * One row per planned change plus one per changed sensitive output, high-risk rows first.
 * A row is high risk when it destroys, replaces, touches an IAM or secret type, or has an
 * action this tool does not recognize. Reading a data source of such a type is not a change.
 */
export function classifyRisks(events: PlanEvents): RiskRow[] {
  const rows: RiskRow[] = events.changes.map((change) => {
    const flags: RiskFlag[] = [];
    const type = change.type ?? "";
    if (change.action === "DESTROY" || change.action === "REPLACE") flags.push("destroy");
    if (change.action === "REPLACE") flags.push(`replace(${change.reason ?? "unknown"})`);
    if (change.action === "unknown") flags.push("unknown");
    if (change.action !== "read") {
      if (isIamType(type)) flags.push("iam");
      if (isSecretType(type)) flags.push("secret");
    }
    return { ...change, flags, level: flags.length ? "high" : "low" };
  });
  for (const output of events.outputs) {
    if (!output.sensitive || output.action === "noop") continue;
    const row: RiskRow = {
      address: `output.${output.name}`,
      action: output.action as PlanAction,
      flags: ["secret"],
      level: "high",
    };
    if (output.raw !== undefined) row.raw = output.raw;
    rows.push(row);
  }
  // Array.prototype.sort is stable, so plan order is kept within each level.
  return rows.sort((a, b) => Number(b.level === "high") - Number(a.level === "high"));
}
