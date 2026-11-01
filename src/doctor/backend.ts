import { realpathSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Backend } from "./rules.js";

function withoutComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|#.*|\/\/[^:\n].*|\/\*[\s\S]*?\*\//g, (match) =>
    match.startsWith('"') ? match : " ".repeat(match.length),
  );
}

function blockBody(source: string, start: number): string | undefined {
  const open = source.indexOf("{", start);
  if (open < 0) return undefined;
  let depth = 1;
  let quoted = false;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '"' && source[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && source[i] === "{") depth++;
    else if (!quoted && source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return undefined;
}

export function inspectBackend(module: string): Backend | undefined {
  const directory = realpathSync(resolve(module));
  const unsafePath = resolve(homedir(), "Code", "infrastructure");
  let unsafe: string;
  try {
    unsafe = realpathSync(unsafePath);
  } catch {
    unsafe = unsafePath;
  }
  const protectedPath = (path: string) => path === unsafe || path.startsWith(`${unsafe}/`);
  if (protectedPath(directory)) throw new Error("refusing to inspect the protected infrastructure directory");
  const sources = readdirSync(directory)
    .filter((file) => file.endsWith(".tf"))
    .map((file) => {
      const path = realpathSync(resolve(directory, file));
      if (protectedPath(path)) throw new Error("refusing to inspect the protected infrastructure directory");
      return readFileSync(path, "utf8");
    });
  const source = withoutComments(sources.join("\n"));
  const terraformBlocks = /\bterraform\s*\{/g;
  let block: RegExpMatchArray | null = null;
  let body: string | undefined;
  for (const match of source.matchAll(terraformBlocks)) {
    const terraform = blockBody(source, match.index!);
    if (!terraform) continue;
    const backendStart = terraform.search(/\bbackend\s+"[\w-]+"\s*\{/);
    if (backendStart < 0) continue;
    const backend = terraform.slice(backendStart);
    block = backend.match(/^\s*backend\s+"([\w-]+)"\s*\{/);
    body = block ? blockBody(backend, 0) : undefined;
    if (block && body) break;
  }
  if (!block || !body) return undefined;
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
