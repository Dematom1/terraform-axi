// Builds the throwaway local-backend module used by the demo and token benchmark.
// Prior state is written by hand so the plan has updates, a replacement, a destroy and drift; nothing is applied.
// Usage: node demo/fixture.mjs <empty-directory>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const services = ["api", "web", "worker", "scheduler", "billing", "search", "auth", "notifications"];
const builtin = 'provider["terraform.io/builtin/terraform"]';
const local = 'provider["registry.terraform.io/hashicorp/local"]';

const data = (name, attributes, index) => ({
  ...(index === undefined ? {} : { index_key: index }),
  schema_version: 0,
  attributes: { id: `${name}-${index ?? "id"}`, input: null, output: null, triggers_replace: null, ...attributes },
  sensitive_attributes: [],
});
const value = (v) => ({ value: v, type: "string" });
const file = (name) => {
  const content = `${name} = enabled\n`;
  const hash = (algorithm, encoding = "hex") => createHash(algorithm).update(content).digest(encoding);
  return {
    schema_version: 0,
    attributes: {
      id: hash("sha1"),
      content,
      content_md5: hash("md5"),
      content_sha1: hash("sha1"),
      content_sha256: hash("sha256"),
      content_base64sha256: hash("sha256", "base64"),
      content_sha512: hash("sha512"),
      content_base64sha512: hash("sha512", "base64"),
      filename: `rendered/${name}.conf`,
      file_permission: "0777",
      directory_permission: "0777",
      content_base64: null,
      sensitive_content: null,
      source: null,
    },
    sensitive_attributes: [[{ type: "get_attr", value: "sensitive_content" }]],
  };
};

/** @param {string} directory @param {string} binary */
export function buildFixture(directory, binary = "terraform") {
  const resources = [
    {
      mode: "managed",
      type: "terraform_data",
      name: "service",
      provider: builtin,
      instances: services.map((s, i) => data("service", { input: value(`${s}:v1`), output: value(`${s}:v1`) }, i)),
    },
    {
      mode: "managed",
      type: "terraform_data",
      name: "database",
      provider: builtin,
      instances: [data("database", { triggers_replace: value("postgres-15") })],
    },
    {
      mode: "managed",
      type: "terraform_data",
      name: "legacy_queue",
      provider: builtin,
      instances: [data("legacy", {})],
    },
    {
      mode: "managed",
      type: "local_file",
      name: "rendered",
      provider: local,
      // Each file's state matches the config; files deleted below show up as drift.
      instances: ["api", "web", "worker"].map((s, i) => ({ index_key: i, ...file(s) })),
    },
  ];
  const state = {
    version: 4,
    terraform_version: "1.0.0",
    serial: 1,
    lineage: "00000000-0000-0000-0000-00000000d3e0",
    outputs: { db_password: { value: "demo-only-not-a-secret", type: "string", sensitive: true } },
    resources,
  };
  const main = `terraform {
  backend "local" {}
  required_providers {
    local = { source = "hashicorp/local", version = "2.5.3" }
  }
}

locals {
  services = ${JSON.stringify(services)}
  rendered = ["api", "web", "worker"]
}

resource "terraform_data" "service" {
  count = length(local.services)
  input = "\${local.services[count.index]}:v2"
}

resource "terraform_data" "database" {
  triggers_replace = "postgres-16"
}

resource "terraform_data" "cache" {}

resource "local_file" "rendered" {
  count    = length(local.rendered)
  filename = "rendered/\${local.rendered[count.index]}.conf"
  content  = "\${local.rendered[count.index]} = enabled\\n"
}

output "db_password" {
  value     = "demo-only-not-a-secret"
  sensitive = true
}
`;
  mkdirSync(join(directory, "rendered"), { recursive: true });
  writeFileSync(join(directory, "main.tf"), main);
  writeFileSync(join(directory, "terraform.tfstate"), JSON.stringify(state, null, 2));
  // Only "api" exists on disk: "web" and "worker" were deleted outside Terraform, which is the drift.
  writeFileSync(join(directory, "rendered", "api.conf"), "api = enabled\n");
  execFileSync(binary, [`-chdir=${directory}`, "init", "-input=false", "-no-color"], {
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: directory, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
  });
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: node demo/fixture.mjs <empty-directory>");
  buildFixture(directory);
}
