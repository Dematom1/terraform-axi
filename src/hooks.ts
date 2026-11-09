import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeSessionStartHookRemoval,
  computeSessionStartHookUpdate,
  sessionStartHookStatus,
  type HookSettings,
  type HookGroup,
} from "axi-sdk-js";
import { CliError } from "./errors.js";

const marker = "terraform-axi";
const plugin = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "opencode.js")).href;
const pluginSource = `// axi-sdk-js managed opencode plugin: ${marker}\nexport { default } from ${JSON.stringify(plugin)};\n`;
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

export function hookStatus() {
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
  const hasCapture = (path: string): boolean => {
    const entries = readSettings(path)?.hooks?.SessionEnd;
    return Boolean(
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          "hooks" in entry &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some(
            (hook) =>
              hook !== null &&
              typeof hook === "object" &&
              "command" in hook &&
              typeof hook.command === "string" &&
              hook.command.includes(`${marker}-ctx`) &&
              hook.command.includes("--capture"),
          ),
      ),
    );
  };
  return {
    ...status,
    claude: { ...status.claude, capture_installed: hasCapture(status.claude.path) },
    codex: { ...status.codex, capture_installed: hasCapture(status.codex.path) },
    opencode: {
      ...status.opencode,
      capture_installed: status.opencode.installed && readFileSync(status.opencode.path, "utf8") === pluginSource,
    },
  };
}

export function repairHookDuplicates(removeCapture = false): void {
  const status = hookStatus();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "terraform-axi-ctx.js");
  const command = `${quote(process.execPath)} ${quote(entrypoint)}`;
  for (const path of [status.claude.path, status.codex.path]) {
    const current = readSettings(path);
    if (!current) continue;
    // SDK 0.1.13 updates only the first match. Remove all managed entries in memory,
    // then add one; unrelated hooks survive and the file is never left uninstalled.
    let updated = current;
    if (!removeCapture) {
      const [removed] = computeSessionStartHookRemoval(current, marker);
      [updated] = computeSessionStartHookUpdate(removed, { marker, command });
    }
    const end = updated.hooks?.SessionEnd;
    if (
      end &&
      (!Array.isArray(end) ||
        !end.every((entry): entry is HookGroup => entry !== null && typeof entry === "object" && !("command" in entry)))
    )
      throw new CliError(`CONFIG_ERROR: ${path}: invalid SessionEnd groups`);
    const proxy: HookSettings = { hooks: { ...(end ? { SessionStart: end } : {}) } };
    const [removedEnd] = computeSessionStartHookRemoval(proxy, marker);
    const withEnd = removeCapture
      ? removedEnd
      : computeSessionStartHookUpdate(removedEnd, { marker, command: `${command} --capture`, timeoutSeconds: 3 })[0];
    updated = structuredClone(updated);
    updated.hooks ??= {};
    if (withEnd.hooks?.SessionStart) updated.hooks.SessionEnd = withEnd.hooks.SessionStart;
    else delete updated.hooks.SessionEnd;
    const { SessionStart, SessionEnd, ...otherEvents } = updated.hooks;
    updated.hooks = {
      ...otherEvents,
      ...(SessionStart ? { SessionStart } : {}),
      ...(SessionEnd ? { SessionEnd } : {}),
    };
    if (!Object.keys(updated.hooks).length) delete updated.hooks;
    if (JSON.stringify(current) !== JSON.stringify(updated))
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }
  if (!removeCapture && status.opencode.installed && readFileSync(status.opencode.path, "utf8") !== pluginSource)
    writeFileSync(status.opencode.path, pluginSource, "utf8");
}
