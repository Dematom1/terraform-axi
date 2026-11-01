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

  it("keeps metadata offsets correct after non-BMP text", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      '# 😀\nterraform { backend "s3" { endpoint = "https://s3.example.com" region = "us-east-1" } }',
    );
    expect(inspectBackend(directory)).toMatchObject({ endpointHost: "s3.example.com", region: "us-east-1" });
  });

  it("does not extract commented endpoint or region values", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `terraform { backend "s3" {\n # endpoint = "https://s3.example.com"\n // region = "us-east-1"\n } }`,
    );
    expect(inspectBackend(directory)).toMatchObject({ type: "s3" });
    expect(inspectBackend(directory)).not.toHaveProperty("endpointHost");
    expect(inspectBackend(directory)).not.toHaveProperty("region");
  });

  it("ignores backend-like text outside terraform and preserves comment markers in strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `terraform {}\nresource "terraform_data" "x" { input = "backend "s3" { region = "x" } // #" }`,
    );
    expect(inspectBackend(directory)).toBeUndefined();
  });

  it("ignores terraform and backend syntax inside quoted strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      'resource "terraform_data" "x" { input = "terraform { backend "s3" { region = "x" } }" }',
    );
    expect(inspectBackend(directory)).toBeUndefined();
  });

  it("recognizes a backend after a string ending in an escaped backslash", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      String.raw`resource "terraform_data" "x" { input = "ends\\" }
terraform { backend "s3" { region = "us-east-1" } }`,
    );
    expect(inspectBackend(directory)).toMatchObject({ type: "s3", region: "us-east-1" });
  });

  it("ignores backend syntax inside heredocs", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `resource "terraform_data" "x" {\n input = <<EOF\nterraform { backend "s3" { region = "x" } }\nEOF\n}`,
    );
    expect(inspectBackend(directory)).toBeUndefined();
  });

  it("resumes structural scanning after an indented heredoc terminator", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `resource "terraform_data" "x" {\n input = <<-EOF\nterraform { backend "gcs" {} }\n EOF\n}\nterraform { backend "s3" { region = "us-east-1" } }`,
    );
    expect(inspectBackend(directory)).toMatchObject({ type: "s3", region: "us-east-1" });
  });

  it("extracts fields when backend follows another terraform block", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      'terraform { required_version = ">= 1.0" backend "s3" { endpoint = "https://s3.example.com" region = "us-east-1" } }',
    );
    expect(inspectBackend(directory)).toMatchObject({ endpointHost: "s3.example.com", region: "us-east-1" });
  });

  it("finds a backend in a later terraform block across module files", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(join(directory, "main.tf"), "terraform {}");
    writeFileSync(join(directory, "backend.tf"), 'terraform { backend "s3" { region = "us-east-1" } }');
    expect(inspectBackend(directory)).toMatchObject({ type: "s3", region: "us-east-1" });
  });

  it("recognizes a valid backend with an empty configuration body", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(join(directory, "main.tf"), 'terraform { backend "local" {} }');
    expect(inspectBackend(directory)).toMatchObject({ type: "local" });
  });

  it("returns no backend when a module has no static backend block", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(join(directory, "main.tf"), 'resource "terraform_data" "x" {}');
    expect(inspectBackend(directory)).toBeUndefined();
  });
});
