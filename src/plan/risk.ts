import type { PlanAction, PlanChange, PlanEvents } from "./events.js";

export type RiskFlag = "destroy" | `replace(${string})` | "iam" | "secret";
export type RiskRow = PlanChange & { flags: RiskFlag[]; level: "high" | "low" };

const iamTypes = ["aws_iam_", "azurerm_role_assignment", "azurerm_role_definition"];
const secretTypes = [
  "aws_secretsmanager_",
  "aws_ssm_parameter",
  "aws_iam_access_key",
  "aws_kms_",
  "vault_",
  "kubernetes_secret",
  "google_secret_manager_",
  "azurerm_key_vault_",
  "random_password",
  "tls_private_key",
  "b2_application_key",
];
const highAction = new Set<PlanAction>(["DESTROY", "REPLACE"]);

export function classifyRisks(events: PlanEvents): RiskRow[] {
  return events.changes
    .map((change) => {
      const type = change.type ?? "";
      const flags: RiskFlag[] = [];
      if (highAction.has(change.action)) flags.push("destroy");
      if (change.action === "REPLACE") flags.push(`replace(${change.reason ?? "unknown"})`);
      if (
        iamTypes.some((prefix) => type.startsWith(prefix)) ||
        (/^google_(?:[^_]+_iam_|project_iam_)/.test(type)) ||
        (type.startsWith("kubernetes_") && type.includes("role")) ||
        (/^github_.+_permission/.test(type))
      ) flags.push("iam");
      if (
        secretTypes.some((prefix) => type.startsWith(prefix)) &&
        (type.startsWith("kubernetes_secret") || !type.startsWith("kubernetes_")) ||
        (type.startsWith("github_actions_") && type.includes("secret"))
      ) flags.push("secret");
      return { ...change, flags, level: flags.length ? ("high" as const) : ("low" as const) };
    })
    .concat(
      events.outputs
        .filter((output) => output.sensitive && output.action !== "noop")
        .map((output) => ({
          address: `output.${output.name}`,
          action: output.action as PlanAction,
          flags: ["secret"],
          level: "high" as const,
        })),
    )
    .sort((a, b) => Number(b.level === "high") - Number(a.level === "high"));
}
