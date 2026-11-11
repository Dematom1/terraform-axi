import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSessionId } from "./sessions.js";

const COMMANDS = ["plan", "drift", "lint", "diagnose", "doctor", "state", "setup"];
const MAX_TRANSCRIPT_BYTES = 1_000_000;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : undefined;
export function directory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
export function scopedModules(modules: string[], cwd: string, paths: Record<string, string> = {}): string[] {
  const current = directory(cwd);
  return modules.filter((module) => {
    // Older relative registrations have no stable origin; re-register them with setup.
    const root = isAbsolute(module) ? module : Object.hasOwn(paths, module) ? paths[module] : undefined;
    if (!root) return false;
    const delta = relative(directory(root), current);
    return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
  });
}
const captureDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "captures");
type Capture = {
  cwd: string;
  session: string;
  ended_at: string;
  commands: Record<string, number>;
  files_touched: number;
  transcript_bytes: number;
  scanned_bytes: number;
};
function counts(value: unknown): Record<string, number> {
  const entries = object(value) ?? {};
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, count]) =>
      COMMANDS.includes(key) && typeof count === "number" && Number.isSafeInteger(count) && count > 0
        ? [[key, count]]
        : [],
    ),
  );
}

/** Explicit lifecycle action. Persist counts only, never transcript text, command arguments or file names. */
export function captureSession(input: unknown): void {
  const event = object(input);
  if (!event || !isSessionId(event.session_id) || typeof event.cwd !== "string" || !isAbsolute(event.cwd))
    throw new Error("capture requires session_id and absolute cwd");
  const commands = counts(event.commands);
  const files = new Set<string>();
  let transcriptBytes = 0;
  let scannedBytes = 0;
  if (typeof event.transcript_path === "string") {
    const fd = openSync(event.transcript_path, "r");
    let text: string;
    try {
      transcriptBytes = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(transcriptBytes, MAX_TRANSCRIPT_BYTES));
      scannedBytes = readSync(fd, buffer, 0, buffer.length, Math.max(0, transcriptBytes - buffer.length));
      text = buffer.subarray(0, scannedBytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
    // ponytail: recognizes CLI text, not arbitrary shell syntax; use a shell parser if audit-grade counts are needed.
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 20) return;
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, depth + 1);
        return;
      }
      const row = object(value);
      if (!row) return;
      // Claude tool_use and Codex function_call transcript records.
      if (row.type === "tool_use" || row.type === "function_call") {
        let args = row.input;
        if (typeof row.arguments === "string") {
          try {
            args = JSON.parse(row.arguments);
          } catch {
            /* malformed tool arguments */
          }
        }
        const tool = object(args);
        const command = tool?.command ?? tool?.cmd;
        if (typeof command === "string") {
          for (const match of command.matchAll(/\bterraform-axi\s+(plan|drift|lint|diagnose|doctor|state|setup)\b/g)) {
            const name = match[1]!;
            commands[name] = (commands[name] ?? 0) + 1;
          }
        }
        if (["Write", "Edit", "write", "edit"].includes(String(row.name)) && typeof tool?.file_path === "string")
          files.add(tool.file_path);
      }
      for (const entry of Object.values(row)) visit(entry, depth + 1);
    };
    for (const line of text.split("\n")) {
      try {
        visit(JSON.parse(line));
      } catch {
        /* partial or unsupported transcript line */
      }
    }
  }
  const cwd = directory(event.cwd);
  const session = createHash("sha256").update(`${event.session_id}\0${cwd}`).digest("hex");
  const capture: Capture = {
    cwd,
    session,
    commands,
    files_touched: files.size,
    transcript_bytes: transcriptBytes,
    scanned_bytes: scannedBytes,
    ended_at: new Date().toISOString(),
  };
  const dir = captureDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Separate session files avoid a shared-writer lock; rename makes each summary atomic and retries replace it.
  const temporary = join(dir, `${session}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(dir, `${session}.json`));
}

export function lastCapture(cwd: string, current?: string): Omit<Capture, "cwd" | "session"> | undefined {
  const canonical = directory(cwd);
  const key = current ? createHash("sha256").update(`${current}\0${canonical}`).digest("hex") : undefined;
  let last: Capture | undefined;
  // ponytail: scans retained session summaries; add retention if history grows large.
  try {
    for (const file of readdirSync(captureDir())) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const row = object(JSON.parse(readFileSync(join(captureDir(), file), "utf8")));
        if (
          !row ||
          row.cwd !== canonical ||
          row.session === key ||
          typeof row.session !== "string" ||
          typeof row.ended_at !== "string"
        )
          continue;
        if (
          typeof row.files_touched !== "number" ||
          typeof row.transcript_bytes !== "number" ||
          typeof row.scanned_bytes !== "number"
        )
          continue;
        if (!last || row.ended_at > last.ended_at)
          last = {
            cwd: canonical,
            session: row.session,
            ended_at: row.ended_at,
            commands: counts(row.commands),
            files_touched: row.files_touched,
            transcript_bytes: row.transcript_bytes,
            scanned_bytes: row.scanned_bytes,
          };
      } catch {
        /* ignore incomplete or malformed optional memory */
      }
    }
  } catch {
    /* no captured sessions */
  }
  if (!last) return undefined;
  const { commands, ended_at, files_touched, transcript_bytes, scanned_bytes } = last;
  return { commands, ended_at, files_touched, transcript_bytes, scanned_bytes };
}
