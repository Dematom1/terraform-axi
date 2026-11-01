import type { StateDetail, StateModel } from "./model.js";

const SECRET_KEYS = [
  "password",
  "secret",
  "token",
  "private_key",
  "key_material",
  "access_key",
  "secret_key",
  "credentials",
  "connection_string",
  "kubeconfig",
  "client_key",
  "client_certificate",
  "private_key_pem",
  "master_password",
  "auth",
];
const SECRET_TYPES = [
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
const REDACTED = "[redacted]";
type Redaction = { value: unknown; count: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function secretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((part) => lower.includes(part));
}
function redact(value: unknown, sensitivity: unknown, force: boolean): Redaction {
  if (force || sensitivity === true) return { value: REDACTED, count: 1 };
  if (Array.isArray(value)) {
    const marks = Array.isArray(sensitivity) ? sensitivity : [];
    const results = value.map((entry, index) => redact(entry, marks[index], false));
    return {
      value: results.map((result) => result.value),
      count: results.reduce((sum, result) => sum + result.count, 0),
    };
  }
  if (isObject(value)) {
    const marks = isObject(sensitivity) ? sensitivity : {};
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      const result = redact(entry, marks[key], secretKey(key));
      output[key] = result.value;
      count += result.count;
    }
    return { value: output, count };
  }
  return { value, count: 0 };
}

export type RedactedState = {
  resources: (StateDetail & { attributes: Record<string, unknown> })[];
  outputs: StateModel["outputs"];
  redacted: number;
};
export function redactState(state: StateModel): RedactedState {
  let redacted = 0;
  const resources = state.details.map((detail) => {
    const resourceType = detail.type.toLowerCase();
    const wholeResource =
      SECRET_TYPES.some((type) => resourceType.startsWith(type)) ||
      (resourceType.startsWith("github_actions_") && resourceType.includes("secret"));
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail.attributes)) {
      const force = wholeResource && !["id", "arn", "name"].includes(key.toLowerCase());
      const result = redact(
        value,
        isObject(detail.sensitiveValues) ? detail.sensitiveValues[key] : undefined,
        force || secretKey(key),
      );
      attributes[key] = result.value;
      redacted += result.count;
    }
    return { ...detail, attributes };
  });
  return { resources, outputs: state.outputs, redacted };
}
