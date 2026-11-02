import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";
import { realpathSync, readdirSync, readFileSync } from "node:fs";
import { CliError } from "../errors.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Backend } from "./rules.js";

function heredocEnd(source: string, start: number): number | undefined {
  const marker = /^<<-?([A-Za-z_]\w*)/.exec(source.slice(start));
  if (!marker) return undefined;
  const lineEnd = source.indexOf("\n", start);
  const bodyStart = lineEnd < 0 ? source.length : lineEnd + 1;
  const terminator = new RegExp(`^${marker[1]}[\\t ]*\\r?$`, "m");
  const indentedTerminator = new RegExp(`^[\\t ]*${marker[1]}[\\t ]*\\r?$`, "m");
  const found = (marker[0].startsWith("<<-") ? indentedTerminator : terminator).exec(source.slice(bodyStart));
  return found ? bodyStart + found.index + found[0].length : source.length;
}

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
      const end = heredocEnd(source, i);
      if (end !== undefined) {
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
    } else if (source.startsWith("<<", i)) {
      const end = heredocEnd(source, i);
      if (end !== undefined) {
        for (let j = i; j < end; j++) if (source[j] !== "\n") chars[j] = " ";
        i = end - 1;
      }
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

export function probeEndpoint(host: string, port = 443): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("unreachable (timeout)");
    }, 3_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("reachable");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve("unreachable (connect)");
    });
  });
}

function endpointTarget(value: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return { host, port: Number(url.port || (url.protocol === "http:" ? 80 : 443)) };
  } catch {
    return undefined;
  }
}

export function defaultS3Endpoint(region: string): string | undefined {
  if (region === "us-east-1") return "s3.amazonaws.com";
  if (/^cn-[a-z]+-\d+$/.test(region)) return `s3.${region}.amazonaws.com.cn`;
  if (/^(?:us-gov|us-(?!iso-)|eu|ap|ca|me|af|sa|il|mx)-[a-z0-9-]+-\d+$/.test(region))
    return `s3.${region}.amazonaws.com`;
  return undefined;
}

export async function probeBackend(
  backend: Backend,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const override = backend.type === "s3" ? env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL : undefined;
  let host = backend.endpointHost;
  let port = backend.endpointPort ?? 443;
  if (override) {
    const target = endpointTarget(override);
    if (!target) return "not probed (no endpoint derivable)";
    ({ host, port } = target);
  }
  if (!host && backend.type === "s3" && backend.region) host = defaultS3Endpoint(backend.region);
  if (!host) return "not probed (no endpoint derivable)";
  if (isIP(host)) return probeEndpoint(host, port);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }).then((results) => results.map(({ address }) => address)),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => {
          reject(new Error("DNS timeout"));
        }, 3_000);
      }),
    ]);
    if (!addresses.length) return "unreachable (dns)";
    const results = await Promise.all(addresses.map((address) => probeEndpoint(address, port)));
    if (results.includes("reachable")) return "reachable";
    return results.includes("unreachable (timeout)") ? "unreachable (timeout)" : "unreachable (connect)";
  } catch (error) {
    return error instanceof Error && error.message === "DNS timeout" ? "unreachable (timeout)" : "unreachable (dns)";
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
}

export function inspectBackend(module: string): Backend | undefined {
  let directory: string;
  try {
    directory = realpathSync(resolve(module));
  } catch {
    throw new CliError(`module directory not found or inaccessible: ${module}`);
  }
  const unsafePath = resolve(homedir(), "Code", "infrastructure");
  let unsafe: string;
  try {
    unsafe = realpathSync(unsafePath);
  } catch {
    unsafe = unsafePath;
  }
  const protectedPath = (path: string) => path === unsafe || path.startsWith(`${unsafe}/`);
  if (protectedPath(directory)) throw new CliError("refusing to inspect the protected infrastructure directory");
  let source: string;
  try {
    source = readdirSync(directory)
      .filter((file) => file.endsWith(".tf"))
      .map((file) => {
        const path = realpathSync(resolve(directory, file));
        if (protectedPath(path)) throw new CliError("refusing to inspect the protected infrastructure directory");
        return readFileSync(path, "utf8");
      })
      .join("\n");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`module directory not found or inaccessible: ${module}`);
  }
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
  if (body === undefined || !backendType) return undefined;
  const values = maskComments(body);
  const value = (name: string, source = values) =>
    source.match(new RegExp(`\\b${name}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`))?.[1];
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
  const structureBody = maskSyntax(body);
  const endpointsStart = /\bendpoints\s*=/.exec(structureBody)?.index;
  const endpointsRange = endpointsStart === undefined ? undefined : blockRange(structureBody, endpointsStart);
  const endpoint =
    value("endpoint") ?? (endpointsRange ? value("s3", values.slice(endpointsRange[0], endpointsRange[1])) : undefined);
  const endpointDetails = endpoint ? endpointTarget(endpoint) : undefined;
  const region = value("region");
  return {
    type: backendType,
    ...(endpointDetails ? { endpointHost: endpointDetails.host, endpointPort: endpointDetails.port } : {}),
    ...(region ? { region } : {}),
    flags,
    inlineCredentials: /\b(?:access_key|secret_key|token|password|client_secret)\s*=/.test(maskSyntax(body)),
  };
}
