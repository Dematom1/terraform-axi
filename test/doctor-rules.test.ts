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

  it("recognizes configured regions and only actual B2 hostnames", () => {
    const backend = { type: "s3", endpointHost: "not-backblazeb2.com.attacker.example", region: "us-west-2", flags: {}, inlineCredentials: false };
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
      ["unsupported x-amz-checksum-sha256", "checksum header"],
    ];
    for (const [text, cause] of fixtures) expect(explain(text)?.cause).toContain(cause);
  });
});
