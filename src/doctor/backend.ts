import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Backend } from "./rules.js";

export function inspectBackend(module: string): Backend | undefined {
  const directory = resolve(module);
  const unsafe = resolve(homedir(), "Code", "infrastructure");
  if (directory === unsafe || directory.startsWith(`${unsafe}/`))
    throw new Error("refusing to inspect the protected infrastructure directory");
  const sources = readdirSync(directory)
    .filter((file) => file.endsWith(".tf"))
    .map((file) => readFileSync(resolve(directory, file), "utf8"));
  const source = sources.join("\n");
  const block = source.match(/backend\s+"([\w-]+)"\s*\{([^{}]*)\}/);
  if (!block) return undefined;
  const body = block[2]!;
  const value = (name: string) => body.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];
  const flags: Backend["flags"] = {};
  for (const name of [
    "skip_credentials_validation",
    "skip_region_validation",
    "skip_requesting_account_id",
    "skip_metadata_api_check",
    "skip_s3_checksum",
    "use_path_style",
  ] as const)
    flags[name] = new RegExp(`\\b${name}\\s*=\\s*true\\b`).test(body);
  const endpoint = value("endpoint");
  let endpointHost: string | undefined;
  try {
    endpointHost = endpoint ? new URL(endpoint).hostname : undefined;
  } catch {
    endpointHost = undefined;
  }
  const region = value("region");
  return {
    type: block[1]!,
    ...(endpointHost ? { endpointHost } : {}),
    ...(region ? { region } : {}),
    flags,
    inlineCredentials: /\b(?:access_key|secret_key|token|password|client_secret)\s*=/.test(body),
  };
}
