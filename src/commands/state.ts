import { encode } from "@toon-format/toon";
import { parseArgs } from "../args.js";
import type { Config } from "../config.js";
import { UsageError } from "../errors.js";
import { runOperation } from "../runner.js";
import { parseState } from "../state/model.js";
import { redactState } from "../state/redact.js";

function parse(raw: string) {
  try {
    return parseState(raw);
  } catch (error) {
    throw new Error(
      `state parse failed: ${Buffer.byteLength(raw)} bytes (${error instanceof Error ? error.name : "Error"})`,
    );
  }
}
function resourceType(address: string): string {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < address.length; i++) {
    const char = address[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (depth > 0) {
      if (char === '"') quoted = true;
      else if (char === "[") depth++;
      else if (char === "]") depth--;
    } else if (char === "[") depth = 1;
    else if (char === ".") {
      parts.push(address.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(address.slice(start));
  return parts.at(-2) ?? "unknown";
}
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const prior = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[b.length]!;
}
function cut(value: unknown): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) return value.map(cut);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cut(entry)]));
  return value;
}

export async function stateCommand(config: Config, argv: string[]): Promise<string> {
  const { command, positional, values } = parseArgs(argv, [{ name: "--full", boolean: true }]);
  const full = values["--full"] !== undefined;
  if (command === "list") {
    if (positional.length !== 1) throw new UsageError("usage: terraform-axi state list <module> [--full]");
    const module = positional[0]!;
    const addresses = (await runOperation(config, module, "state_list")).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!addresses.length) return encode({ status: "empty_state", total: 0, resources: [] });
    let types = new Map<string, string>();
    if (full)
      types = new Map(
        parse((await runOperation(config, module, "show_state")).stdout).resources.map((r) => [r.address, r.type]),
      );
    return encode({
      resources: addresses
        .slice(0, 100)
        .map((address) => ({ address, type: types.get(address) ?? resourceType(address) })),
      total: addresses.length,
    });
  }
  if (command === "resource") {
    if (positional.length !== 2)
      throw new UsageError("usage: terraform-axi state resource <module> <address> [--full]");
    const module = positional[0]!;
    const address = positional[1]!;
    const model = parse((await runOperation(config, module, "show_state")).stdout);
    const redacted = redactState(model);
    const resource = redacted.resources.find((item) => item.address === address);
    if (!resource) {
      const closest = [...model.resources]
        .sort((a, b) => distance(address, a.address) - distance(address, b.address))
        .slice(0, 3)
        .map(({ address: item }) => item);
      return encode({
        status: model.resources.length ? "not_found" : "empty_state",
        ...(model.resources.length ? { address, closest } : {}),
      });
    }
    return encode({
      ...resource,
      attributes: full ? resource.attributes : cut(resource.attributes),
      redacted: redacted.redacted,
    });
  }
  throw new UsageError("usage: terraform-axi state list <module> | state resource <module> <address>");
}
