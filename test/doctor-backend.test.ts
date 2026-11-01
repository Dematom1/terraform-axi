import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectBackend } from "../src/doctor/backend.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("static backend inspection", () => {
  it("reports backend metadata without returning inline secret values", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `terraform { backend "s3" { endpoint = "https://s3.us-west-004.backblazeb2.com" region = "us-west-004" secret_key = "never-return-this" skip_s3_checksum = true } }`,
    );
    const result = inspectBackend(directory);
    expect(result).toMatchObject({
      type: "s3",
      endpointHost: "s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      inlineCredentials: true,
      flags: { skip_s3_checksum: true },
    });
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  it("ignores backend-like text outside terraform and preserves comment markers in strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `terraform {}\nresource "terraform_data" "x" { input = "backend \\\"s3\\\" { region = \\\"x\\\" } // #" }`,
    );
    expect(inspectBackend(directory)).toBeUndefined();
  });

  it("returns no backend when a module has no static backend block", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(join(directory, "main.tf"), 'resource "terraform_data" "x" {}');
    expect(inspectBackend(directory)).toBeUndefined();
  });
});
