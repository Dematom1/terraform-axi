import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSessionStartHookRemoval,
  computeSessionStartHookUpdate,
  sessionStartHookStatus,
  type HookSettings,
} from "axi-sdk-js";
import { CliError } from "./errors.js";

const marker = "terraform-axi";
function readSettings(path: string): HookSettings | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected settings object");
    return { ...value };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new CliError(`CONFIG_ERROR: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function hookStatus(): ReturnType<typeof sessionStartHookStatus> {
  const status = sessionStartHookStatus({ marker });
  // SDK status currently treats unreadable or malformed settings as absent.
  for (const path of [status.claude.path, status.codex.path]) readSettings(path);
  for (const path of [status.codex.userFeaturePath, status.opencode.path]) {
    try {
      readFileSync(path, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw new CliError(`CONFIG_ERROR: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return status;
}

export function repairHookDuplicates(): void {
  const status = hookStatus();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "terraform-axi-ctx.js");
  const command = `${quote(process.execPath)} ${quote(entrypoint)}`;
  for (const path of [status.claude.path, status.codex.path]) {
    const current = readSettings(path);
    if (!current) continue;
    // SDK 0.1.13 updates only the first match. Remove all managed entries in memory,
    // then add one; unrelated hooks survive and the file is never left uninstalled.
    const [removed] = computeSessionStartHookRemoval(current, marker);
    const [updated] = computeSessionStartHookUpdate(removed, { marker, command });
    if (JSON.stringify(current) !== JSON.stringify(updated))
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }
}
