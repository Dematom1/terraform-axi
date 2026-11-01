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
import { dirname } from "node:path";
import { CliError } from "./errors.js";

export type Config = { binary: "terraform" | "tofu" | "auto"; wrapper?: string; modules: string[] };
export const defaults: Config = { binary: "auto", modules: [] };
export function readConfig(path: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { ...defaults };
    throw new CliError(`malformed config: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`malformed config: ${path}`);
  const record = value as Record<string, unknown>;
  if (
    (record.binary !== undefined &&
      (typeof record.binary !== "string" || !["auto", "terraform", "tofu"].includes(record.binary))) ||
    (record.modules !== undefined &&
      (!Array.isArray(record.modules) || !record.modules.every((item) => typeof item === "string"))) ||
    (record.wrapper !== undefined && typeof record.wrapper !== "string")
  )
    throw new CliError(`malformed config: ${path}`);
  return {
    binary: (record.binary ?? "auto") as Config["binary"],
    modules: (record.modules ?? []) as string[],
    ...(record.wrapper === undefined ? {} : { wrapper: record.wrapper }),
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
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed */
    }
  }
}
