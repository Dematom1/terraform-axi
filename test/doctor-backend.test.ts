import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { inspectBackend, probeBackend, probeEndpoint } from "../src/doctor/backend.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("backend reachability", () => {
  it("tries all DNS address families until one connects", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener address");
    try {
      await expect(
        probeBackend({
          type: "s3",
          endpointHost: "localhost",
          endpointPort: address.port,
          flags: {},
          inlineCredentials: false,
        }),
      ).resolves.toBe("reachable");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("connects to a listening endpoint and reports a refused connection", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener address");
    try {
      await expect(probeEndpoint("127.0.0.1", address.port)).resolves.toBe("reachable");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await expect(probeEndpoint("127.0.0.1", address.port)).resolves.toBe("unreachable (connect)");
  });

  it("connects to the configured port from an endpoint override", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener address");
    try {
      await expect(
        probeBackend(
          { type: "s3", endpointHost: "not-used.invalid", flags: {}, inlineCredentials: false },
          { AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${address.port}` },
        ),
      ).resolves.toBe("reachable");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses S3-specific endpoint overrides before the global override", async () => {
    const backend = {
      type: "s3",
      endpointHost: "configured.example.com",
      region: "us-east-1",
      flags: {},
      inlineCredentials: false,
    };
    await expect(
      probeBackend(backend, {
        AWS_ENDPOINT_URL_S3: "invalid endpoint",
        AWS_ENDPOINT_URL: "https://fallback.invalid",
      }),
    ).resolves.toBe("not probed (no endpoint derivable)");
    await expect(probeBackend(backend, { AWS_ENDPOINT_URL: "https://global.invalid" })).resolves.toBe(
      "unreachable (dns)",
    );
  });

  it("skips unknown backends without a derivable endpoint", async () => {
    await expect(probeBackend({ type: "gcs", flags: {}, inlineCredentials: false })).resolves.toBe(
      "not probed (no endpoint derivable)",
    );
  });
});

describe("static backend inspection", () => {
  it("translates a missing module path into a CLI error", () => {
    const parent = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(parent);
    expect(() => inspectBackend(join(parent, "missing"))).toThrow(CliError);
  });

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

  it("retains the port from a static endpoint URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(join(directory, "main.tf"), 'terraform { backend "s3" { endpoint = "http://127.0.0.1:9000" } }');
    expect(inspectBackend(directory)).toMatchObject({ endpointHost: "127.0.0.1", endpointPort: 9000 });
  });

  it("reads the S3 endpoint from the endpoints map", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      'terraform { backend "s3" { endpoints = { s3 = "https://s3.us-west-004.backblazeb2.com" } region = "us-west-004" } }',
    );
    expect(inspectBackend(directory)).toMatchObject({ endpointHost: "s3.us-west-004.backblazeb2.com" });
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

  it("does not extract endpoint or region values from heredocs", () => {
    const directory = mkdtempSync(join(tmpdir(), "tfaxi-doctor-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "main.tf"),
      `terraform { backend "s3" {\n endpoint = <<EOF\nhttps://s3.example.com\nEOF\n region = <<-EOF\n us-east-1\n EOF\n } }`,
    );
    expect(inspectBackend(directory)).toMatchObject({ type: "s3" });
    expect(inspectBackend(directory)).not.toHaveProperty("endpointHost");
    expect(inspectBackend(directory)).not.toHaveProperty("region");
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
