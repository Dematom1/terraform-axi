import { realpathSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Backend } from "./rules.js";

function maskSyntax(source: string): string {
  const chars = source.split("");
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    if (quoted) {
      chars[i] = " ";
      if (source[i] === '"' && !escaped) quoted = false;
      escaped = source[i] === "\\" && !escaped;
      if (source[i] !== "\\") escaped = false;
    } else if (source.startsWith("<<", i)) {
      const marker = /^<<-?([A-Za-z_]\w*)/.exec(source.slice(i));
      if (marker) {
        const lineEnd = source.indexOf("\n", i);
        const bodyStart = lineEnd < 0 ? source.length : lineEnd + 1;
        const terminator = new RegExp(`^${marker[1]}[\\t ]*\\r?$`, "m");
        const indentedTerminator = new RegExp(`^[\\t ]*${marker[1]}[\\t ]*\\r?$`, "m");
        const found = (marker[0].startsWith("<<-") ? indentedTerminator : terminator).exec(source.slice(bodyStart));
        const end = found ? bodyStart + found.index + found[0].length : source.length;
        for (let j = i; j < end; j++) if (source[j] !== "\n") chars[j] = " ";
        i = end - 1;
      }
    } else if (source[i] === '"') {
      quoted = true;
      escaped = false;
      chars[i] = " ";
    } else if (source[i] === "#" || source.startsWith("//", i) || source.startsWith("/*", i)) {
      const newline = source.indexOf("\n", i);
      const end =
        source[i] === "#" || source.startsWith("//", i)
          ? newline < 0
            ? source.length
            : newline
          : source.indexOf("*/", i + 2) < 0
            ? source.length
            : source.indexOf("*/", i + 2) + 2;
      for (; i < end; i++) if (source[i] !== "\n") chars[i] = " ";
      i--;
    }
  }
  return chars.join("");
}

function maskComments(source: string): string {
  const chars = source.split("");
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    if (quoted) {
      if (source[i] === '"' && !escaped) quoted = false;
      escaped = source[i] === "\\" && !escaped;
      if (source[i] !== "\\") escaped = false;
    } else if (source[i] === '"') {
      quoted = true;
    } else if (source[i] === "#" || source.startsWith("//", i) || source.startsWith("/*", i)) {
      const newline = source.indexOf("\n", i);
      const end =
        source[i] === "#" || source.startsWith("//", i)
          ? newline < 0
            ? source.length
            : newline
          : source.indexOf("*/", i + 2) < 0
            ? source.length
            : source.indexOf("*/", i + 2) + 2;
      for (; i < end; i++) if (source[i] !== "\n") chars[i] = " ";
      i--;
    }
  }
  return chars.join("");
}

function blockRange(source: string, start: number): [number, number] | undefined {
  const open = source.indexOf("{", start);
  if (open < 0) return undefined;
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return [open + 1, i];
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
  const source = readdirSync(directory)
    .filter((file) => file.endsWith(".tf"))
    .map((file) => {
      const path = realpathSync(resolve(directory, file));
      if (protectedPath(path)) throw new Error("refusing to inspect the protected infrastructure directory");
      return readFileSync(path, "utf8");
    })
    .join("\n");
  const structure = maskSyntax(source);
  let backendType: string | undefined;
  let body: string | undefined;
  for (const terraformMatch of structure.matchAll(/\bterraform\s*\{/g)) {
    const terraformRange = blockRange(structure, terraformMatch.index!);
    if (!terraformRange) continue;
    const terraform = structure.slice(...terraformRange);
    const backendMatch = /\bbackend\b/.exec(terraform);
    if (!backendMatch) continue;
    const backendRange = blockRange(terraform, backendMatch.index);
    if (!backendRange) continue;
    const header = source.slice(terraformRange[0] + backendMatch.index, terraformRange[0] + backendRange[0] - 1);
    backendType = /backend\s+"([\w-]+)"/.exec(header)?.[1];
    body = source.slice(terraformRange[0] + backendRange[0], terraformRange[0] + backendRange[1]);
    if (body && backendType) break;
  }
  if (!body || !backendType) return undefined;
  const values = maskComments(body);
  const value = (name: string) => values.match(new RegExp(`\\b${name}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`))?.[1];
  const flags: Backend["flags"] = {};
  for (const name of [
    "skip_credentials_validation",
    "skip_region_validation",
    "skip_requesting_account_id",
    "skip_metadata_api_check",
    "skip_s3_checksum",
    "use_path_style",
  ] as const)
    flags[name] = new RegExp(`\\b${name}\\s*=\\s*true\\b`).test(maskSyntax(body));
  const endpoint = value("endpoint");
  let endpointHost: string | undefined;
  try {
    endpointHost = endpoint ? new URL(endpoint).hostname : undefined;
  } catch {
    endpointHost = undefined;
  }
  const region = value("region");
  return {
    type: backendType,
    ...(endpointHost ? { endpointHost } : {}),
    ...(region ? { region } : {}),
    flags,
    inlineCredentials: /\b(?:access_key|secret_key|token|password|client_secret)\s*=/.test(maskSyntax(body)),
  };
}
