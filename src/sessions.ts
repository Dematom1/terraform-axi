import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Session = { cwd: string; commands: Record<string, number>; modules: Record<string, number>; ended_at: string };
type Store = { sessions: Session[] };
const dataPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "sessions.json");

function record(input: unknown): Session | undefined {
  if (!input || typeof input !== "object") return;
  const value = input as Record<string, unknown>;
  if (typeof value.cwd !== "string" || typeof value.transcript_path !== "string") return;
  const commands: Record<string, number> = {};
  const modules: Record<string, number> = {};
  try {
    for (const line of readFileSync(value.transcript_path, "utf8").split("\n")) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== "object") continue;
      const content = (row as Record<string, unknown>).message;
      if (!content || typeof content !== "object") continue;
      const body = (content as Record<string, unknown>).content;
      if (!Array.isArray(body)) continue;
      for (const item of body) {
        if (!item || typeof item !== "object") continue;
        const part = item as Record<string, unknown>;
        if (part.type !== "tool_use" || !part.input || typeof part.input !== "object") continue;
        const command = (part.input as Record<string, unknown>).command;
        if (typeof command !== "string") continue;
        for (const match of command.matchAll(/(?:^|[;&|]\s*)terraform-axi\s+(plan|drift|state|doctor)\s+([^\s;&|]+)/g)) {
          commands[match[1]!] = (commands[match[1]!] ?? 0) + 1;
          modules[match[2]!] = (modules[match[2]!] ?? 0) + 1;
        }
      }
    }
  } catch { /* Transcript may have been removed. */ }
  return { cwd: value.cwd, commands, modules, ended_at: new Date().toISOString() };
}

export function recordSession(input: unknown, path = dataPath()): void {
  const session = record(input);
  if (!session) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
      } catch { /* Lock disappeared. */ }
      if (existsSync(lock)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync(fd, `${Date.now()}\n`);
    closeSync(fd);
    let store: Store = { sessions: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).sessions))
        store = parsed as Store;
    } catch { /* Start fresh if the store is absent or malformed. */ }
    store.sessions = [...store.sessions, session].slice(-50);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { unlinkSync(lock); }
}

export function lastSession(path = dataPath(), cwd = process.cwd()): Session | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    const sessions = (parsed as Record<string, unknown>).sessions;
    if (!Array.isArray(sessions)) return;
    for (let index = sessions.length - 1; index >= 0; index--)
      if (sessions[index] && typeof sessions[index] === "object" && (sessions[index] as Session).cwd === cwd)
        return sessions[index] as Session;
    return;
  } catch { return undefined; }
}

