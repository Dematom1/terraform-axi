import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Entry = { s: string | null; cmd: string; module: string | null; t: number };
export type LastSession = { commands: Record<string, number>; modules: Record<string, number>; ended_at: string };

export const MAX_BYTES = 1_000_000;
const TAIL_BYTES = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const sessionsPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "sessions.jsonl");

export function sessionKey(id = process.env.TERRAFORM_AXI_SESSION): string | null {
  return id && SESSION_ID.test(id) ? createHash("sha256").update(id).digest("hex").slice(0, 12) : null;
}

export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

/** Appends one line with a single O_APPEND write. Best-effort: memory never breaks a command. */
export function recordInvocation(cmd: string, module: string | null, path = sessionsPath(), s = sessionKey()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // One old generation is kept; two processes rotating at once can drop it, losing only old memory.
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* no file yet, or another process rotated it first */
    }
    const entry: Entry = { s, cmd, module, t: Math.floor(Date.now() / 1000) };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* unwritable config dir: skip memory */
  }
}

function readTail(path: string): Entry[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object") return [];
        const { s, cmd, module, t } = value as Record<string, unknown>;
        if ((s !== null && typeof s !== "string") || typeof cmd !== "string" || typeof t !== "number") return [];
        return [{ s, cmd, module: typeof module === "string" ? module : null, t }];
      } catch {
        return [];
      }
    });
  } finally {
    closeSync(fd);
  }
}

/** Summarizes the most recent session other than `current`, by log order across the rotated and active tails. */
export function lastSession(current = sessionKey(), path = sessionsPath()): LastSession | undefined {
  const entries = [...readTail(`${path}.1`), ...readTail(path)];
  const target = [...entries].reverse().find((entry) => entry.s !== null && entry.s !== current)?.s;
  if (!target) return undefined;
  const session: LastSession = { commands: {}, modules: {}, ended_at: "" };
  let ended = 0;
  for (const entry of entries) {
    if (entry.s !== target) continue;
    session.commands[entry.cmd] = (session.commands[entry.cmd] ?? 0) + 1;
    if (entry.module) session.modules[entry.module] = (session.modules[entry.module] ?? 0) + 1;
    ended = Math.max(ended, entry.t);
  }
  session.ended_at = new Date(ended * 1000).toISOString();
  return session;
}
