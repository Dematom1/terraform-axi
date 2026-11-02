export type Backend = {
  type: string;
  endpointHost?: string;
  endpointPort?: number;
  region?: string;
  flags: {
    skip_credentials_validation?: boolean;
    skip_region_validation?: boolean;
    skip_requesting_account_id?: boolean;
    skip_metadata_api_check?: boolean;
    skip_s3_checksum?: boolean;
    use_path_style?: boolean;
  };
  inlineCredentials: boolean;
};

export type Finding = {
  id: string;
  severity: "fail" | "warn" | "info";
  message: string;
  next: string;
};

export type Presence = Record<string, "set" | "empty" | "unset">;

const variables: Record<string, readonly string[]> = {
  s3: [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL_S3",
    "AWS_ENDPOINT_URL",
    "AWS_REQUEST_CHECKSUM_CALCULATION",
    "AWS_RESPONSE_CHECKSUM_VALIDATION",
    "B2_APPLICATION_KEY_ID",
    "B2_APPLICATION_KEY",
  ],
  gcs: ["GOOGLE_BACKEND_CREDENTIALS", "GOOGLE_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS"],
  azurerm: [
    "ARM_CLIENT_ID",
    "ARM_CLIENT_SECRET",
    "ARM_TENANT_ID",
    "ARM_SUBSCRIPTION_ID",
    "ARM_USE_OIDC",
    "ARM_ACCESS_KEY",
  ],
  remote: ["TF_CLOUD_ORGANIZATION"],
  cloud: ["TF_CLOUD_ORGANIZATION"],
  http: ["TF_HTTP_USERNAME", "TF_HTTP_PASSWORD"],
  pg: ["PG_CONN_STR"],
};

function status(value: string | undefined): "set" | "empty" | "unset" {
  return value === undefined ? "unset" : value.length === 0 ? "empty" : "set";
}

export function credentialPresence(env: Record<string, string | undefined>, backendType: string): Presence {
  const names = [...(variables[backendType] ?? [])];
  if (backendType === "remote" || backendType === "cloud") {
    names.push(
      ...Object.keys(env)
        .filter((name) => name.startsWith("TF_TOKEN_"))
        .sort(),
    );
  }
  return Object.fromEntries([...new Set(names)].map((name) => [name, status(env[name])]));
}

export function rules(
  env: Record<string, string | undefined>,
  backend: Backend,
): { findings: Finding[]; presence: Presence } {
  const findings: Finding[] = [];
  const present = (name: string) => status(env[name]) === "set";
  if (backend.type === "s3") {
    const host = backend.endpointHost?.toLowerCase();
    const b2 = host === "backblazeb2.com" || host?.endsWith(".backblazeb2.com") === true;
    const awsKeyPair = present("AWS_ACCESS_KEY_ID") && present("AWS_SECRET_ACCESS_KEY");
    const envCredentialsUsed = !backend.inlineCredentials;
    if (backend.inlineCredentials)
      findings.push({
        id: "inline-backend-credentials",
        severity: "warn",
        message:
          "Backend credentials are set in configuration (value hidden); they take precedence over environment credentials.",
        next: "Move credentials to the environment or a wrapper.",
      });
    if (envCredentialsUsed && b2 && (present("B2_APPLICATION_KEY_ID") || present("B2_APPLICATION_KEY")) && !awsKeyPair)
      findings.push({
        id: "b2-keys-invisible",
        severity: "fail",
        message:
          "The s3 backend ignores B2_APPLICATION_KEY_ID/B2_APPLICATION_KEY. Export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with the B2 application key ID and key (or map them in your wrapper).",
        next: "Map the B2 application key ID and key to AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
      });
    if (envCredentialsUsed && b2 && (present("B2_APPLICATION_KEY_ID") || present("B2_APPLICATION_KEY")) && awsKeyPair)
      findings.push({
        id: "aws-overrides-b2",
        severity: "warn",
        message:
          "The backend authenticates with AWS_ACCESS_KEY_ID; B2_* is used only by the b2 provider/CLI. If these hold different keys (e.g. a leftover AWS session), the backend gets 403 InvalidAccessKeyId.",
        next: "Verify the AWS_* credentials are the intended B2 application key pair.",
      });
    if (envCredentialsUsed && b2 && present("AWS_SESSION_TOKEN"))
      findings.push({
        id: "aws-session-token-on-b2",
        severity: "warn",
        message:
          "B2 application keys use no session token; a leftover AWS session token can cause a rejected signature.",
        next: "Unset AWS_SESSION_TOKEN for this module.",
      });
    if (envCredentialsUsed && present("AWS_PROFILE") && awsKeyPair)
      findings.push({
        id: "aws-profile-shadowed",
        severity: "info",
        message: "Static AWS environment keys take precedence over AWS_PROFILE.",
        next: "Unset the static AWS keys to use the profile.",
      });
    if (!backend.region && !present("AWS_REGION") && !present("AWS_DEFAULT_REGION"))
      findings.push({
        id: "region-missing",
        severity: "fail",
        message: "The s3 backend requires a region.",
        next: "Set the backend region, AWS_REGION, or AWS_DEFAULT_REGION.",
      });
    for (const [key, id] of [
      ["skip_credentials_validation", "credentials"],
      ["skip_requesting_account_id", "account-id"],
      ["skip_metadata_api_check", "metadata"],
      ["skip_region_validation", "region"],
      ["skip_s3_checksum", "checksum"],
    ] as const) {
      if (b2 && backend.flags[key] !== true)
        findings.push({
          id: `b2-required-${id}`,
          severity: "warn",
          message: `S3-compatible backends may require ${key}.`,
          next: `Set ${key} for this backend if required.`,
        });
    }
    if (present("AWS_ENDPOINT_URL_S3") || present("AWS_ENDPOINT_URL"))
      findings.push({
        id: "endpoint-env-override",
        severity: "info",
        message: "AWS endpoint environment variables can redirect the backend away from its configured endpoint.",
        next: "Verify AWS_ENDPOINT_URL_S3 and AWS_ENDPOINT_URL.",
      });
  }
  return { findings, presence: credentialPresence(env, backend.type) };
}
