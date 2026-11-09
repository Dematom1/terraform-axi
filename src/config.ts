import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { CliError } from "./errors.js";

export type Config = {
  binary: "terraform" | "tofu" | "auto";
  wrapper?: string;
  modules: string[];
  moduleDirectories?: Record<string, string>;
};
function isDirectoryMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string" && isAbsolute(entry))
  );
}
export const defaults: Config = { binary: "auto", modules: [] };
export function readConfig(path: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { ...defaults };
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
      throw new CliError(
        `CONFIG_FILESYSTEM_ERROR: ${error.code}: ${path}; check permissions and repair or remove this config file`,
      );
    throw new CliError(`malformed config: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`malformed config: ${path}`);
  const record = value as Record<string, unknown>;
  if (
    (record.binary !== undefined &&
      (typeof record.binary !== "string" || !["auto", "terraform", "tofu"].includes(record.binary))) ||
    (record.modules !== undefined &&
      (!Array.isArray(record.modules) || !record.modules.every((item) => typeof item === "string"))) ||
    (record.wrapper !== undefined && typeof record.wrapper !== "string") ||
    (record.moduleDirectories !== undefined && !isDirectoryMap(record.moduleDirectories))
  )
    throw new CliError(`malformed config: ${path}`);
  return {
    binary: (record.binary ?? "auto") as Config["binary"],
    modules: (record.modules ?? []) as string[],
    ...(record.wrapper === undefined ? {} : { wrapper: record.wrapper }),
    ...(isDirectoryMap(record.moduleDirectories) ? { moduleDirectories: record.moduleDirectories } : {}),
  };
}
export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
      throw new CliError(
        `CONFIG_FILESYSTEM_ERROR: ${error.code}: ${path}; check permissions and repair the parent directory`,
      );
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed */
    }
  }
}
