import { describe, expect, it } from "vitest";
import { credentialPresence, rules } from "../src/doctor/rules.js";
import { explain } from "../src/doctor/explain.js";

describe("doctor credential rules", () => {
  it("reports names and presence without exposing values", () => {
    const env = Object.fromEntries(
      ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"].map((name) => [
        name,
        `SENTINEL-${name}`,
      ]),
    );
    const result = rules(env, {
      type: "s3",
      endpointHost: "s3.us-west-004.backblazeb2.com",
      flags: {},
      inlineCredentials: true,
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(result.presence.AWS_ACCESS_KEY_ID).toBe("set");
    expect(result.findings.map(({ id }) => id)).toContain("inline-backend-credentials");
  });

  it("requires a complete AWS key pair for B2 credential mapping", () => {
    const backend = { type: "s3", endpointHost: "s3.backblazeb2.com", flags: {}, inlineCredentials: false };
    const result = rules({ B2_APPLICATION_KEY_ID: "id", AWS_ACCESS_KEY_ID: "id" }, backend);
    expect(result.findings.map(({ id }) => id)).toContain("b2-keys-invisible");
    expect(result.findings.map(({ id }) => id)).not.toContain("aws-overrides-b2");
  });

  it("ignores environment credential findings when inline credentials take precedence", () => {
    const result = rules(
      { B2_APPLICATION_KEY_ID: "id", AWS_SESSION_TOKEN: "token", AWS_PROFILE: "profile" },
      { type: "s3", endpointHost: "s3.backblazeb2.com", flags: {}, inlineCredentials: true },
    );
    const ids = result.findings.map(({ id }) => id);
    expect(ids).toContain("inline-backend-credentials");
    expect(ids).not.toContain("b2-keys-invisible");
    expect(ids).not.toContain("aws-session-token-on-b2");
    expect(ids).not.toContain("aws-profile-shadowed");
  });

  it("requires a complete AWS key pair before reporting a profile shadow", () => {
    const result = rules(
      { AWS_PROFILE: "profile", AWS_ACCESS_KEY_ID: "id" },
      { type: "s3", flags: {}, inlineCredentials: false },
    );
    expect(result.findings.map(({ id }) => id)).not.toContain("aws-profile-shadowed");
  });

  it("recognizes configured regions and only actual B2 hostnames", () => {
    const backend = {
      type: "s3",
      endpointHost: "not-backblazeb2.com.attacker.example",
      region: "us-west-2",
      flags: {},
      inlineCredentials: false,
    };
    const result = rules({}, backend);
    expect(result.findings.map(({ id }) => id)).not.toContain("region-missing");
    expect(result.findings.map(({ id }) => id)).not.toContain("b2-required-checksum");
  });

  it("distinguishes empty and unset variables", () => {
    expect(credentialPresence({ AWS_ACCESS_KEY_ID: "" }, "s3")).toMatchObject({
      AWS_ACCESS_KEY_ID: "empty",
      AWS_SECRET_ACCESS_KEY: "unset",
    });
  });

  it("classifies representative error fixtures (not captured from a live B2 account)", () => {
    const fixtures: [string, string][] = [
      ["HTTP 403 download_cap_exceeded", "Not a credentials problem."],
      ["InvalidAccessKeyId", "key ID"],
      ["SignatureDoesNotMatch", "secret"],
      ["AccessDenied", "lack capability"],
      ["NoSuchBucket", "bucket name"],
      ["connection refused", "unreachable"],
      ["endpoint request timed out", "unreachable"],
      ["unsupported x-amz-checksum-sha256 header", "checksum header"],
      ["GET https://api.github.com/user: 401 Bad credentials []", "invalid, expired, or revoked"],
      ["POST https://api.github.com/enterprises/x/actions/runner-groups: 404 Not Found []", "enterprise request"],
      ["POST https://api.github.com/orgs/x/actions/runner-groups: 403 Forbidden []", "runner group"],
      ["PUT https://api.github.com/orgs/x/teams/y: 403 Resource not accessible by integration []", "GitHub App"],
      ["GET https://api.github.com/orgs/x/hooks: 404 Not Found []", "organization request"],
      ["PUT https://api.github.com/repos/x/y/branches/main/protection: 404 Not Found []", "repository request"],
      ["api error AccessDenied: User: u is not authorized to perform: iam:CreateRole", "IAM permission"],
      ["api error ExpiredToken: The security token included in the request is expired", "expired"],
    ];
    for (const [text, cause] of fixtures) expect(explain(text)?.cause).toContain(cause);
    expect(explain("Error acquiring the state lock: timeout after 30s")).toBeUndefined();
    expect(explain("Request timed out")).toBeUndefined();
    expect(explain("x-amz-checksum-sha256 mismatch")).toBeUndefined();
  });
});
