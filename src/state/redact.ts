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
type PathStep = string | number;

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

function sensitivePath(raw: unknown): PathStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const path: PathStep[] = [];
  for (const rawStep of raw) {
    if (!isObject(rawStep)) return undefined;
    if (rawStep.type === "get_attr" && typeof rawStep.value === "string") path.push(rawStep.value);
    else if (rawStep.type === "index") {
      const index = isObject(rawStep.value) ? rawStep.value.value : rawStep.value;
      if (typeof index !== "string" && typeof index !== "number") return undefined;
      path.push(index);
    } else return undefined;
  }
  return path;
}
function redactPath(value: unknown, path: PathStep[]): Redaction {
  if (path.length === 0) return { value: REDACTED, count: 1 };
  const [step, ...remaining] = path;
  if (typeof step === "number" && Array.isArray(value) && step >= 0 && step < value.length) {
    const result = redactPath(value[step], remaining);
    const output = [...value];
    output[step] = result.value;
    return { value: output, count: result.count };
  }
  if (typeof step === "string" && isObject(value) && Object.hasOwn(value, step)) {
    const result = redactPath(value[step], remaining);
    return { value: { ...value, [step]: result.value }, count: result.count };
  }
  return { value, count: 0 };
}

export type RedactedState = {
  resources: (Pick<StateDetail, "address" | "type" | "provider"> & { attributes: Record<string, unknown> })[];
  outputs: StateModel["outputs"];
  redacted: number;
};
export function redactState(state: StateModel): RedactedState {
  let redacted = 0;
  const resources = state.details.map((detail) => {
    const resourceType = detail.type.toLowerCase();
    // terraform_data input/output can hold secrets Terraform does not mark sensitive.
    const wholeResource =
      resourceType === "terraform_data" ||
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
    if (Array.isArray(detail.sensitiveAttributes)) {
      for (const rawPath of detail.sensitiveAttributes) {
        const path = sensitivePath(rawPath);
        if (!path) continue;
        const result = redactPath(attributes, path);
        Object.assign(attributes, isObject(result.value) ? result.value : attributes);
        redacted += result.count;
      }
    }
    return { address: detail.address, type: detail.type, provider: detail.provider, attributes };
  });
  return { resources, outputs: state.outputs, redacted };
}
