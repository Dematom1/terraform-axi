import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Session = { cwd: string; commands: Record<string, number>; modules: Record<string, number>; ended_at: string };
type ActiveSession = Omit<Session, "ended_at">;
type Store = { active: Record<string, ActiveSession>; sessions: Record<string, Session> };
const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi");
const dataPath = () => join(configDir(), "sessions.json");

function configuredModules(): Set<string> {
  try {
    const config: unknown = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const modules = (config as Record<string, unknown>).modules;
      if (Array.isArray(modules)) return new Set(modules.filter((module): module is string => typeof module === "string"));
    }
  } catch { /* No configured modules. */ }
  return new Set();
}

function readStore(path: string): Store {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed session store");
    const value = parsed as Record<string, unknown>;
    if (value.active !== undefined && (!value.active || typeof value.active !== "object" || Array.isArray(value.active))) throw new Error("malformed session store");
    if (Array.isArray(value.sessions)) {
      const sessions: Store["sessions"] = {};
      value.sessions.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const session = { ...(entry as Record<string, unknown>) };
        delete session.session_id;
        sessions[`legacy-${index}`] = session as Session;
      });
      return { active: (value.active ?? {}) as Store["active"], sessions };
    }
    if (!value.sessions || typeof value.sessions !== "object") throw new Error("malformed session store");
    return { active: (value.active ?? {}) as Store["active"], sessions: value.sessions as Store["sessions"] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { active: {}, sessions: [] };
    throw error;
  }
}

function updateStore(update: (store: Store) => void, path = dataPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const before = statSync(lock);
        const owner = Number(readFileSync(lock, "utf8"));
        let alive = true;
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (error) { alive = !!error && typeof error === "object" && "code" in error && error.code !== "ESRCH"; }
        }
        if (!alive) {
          const stale = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
          renameSync(lock, stale);
          try {
            const moved = statSync(stale);
            if (moved.dev === before.dev && moved.ino === before.ino) {
              unlinkSync(stale);
              continue;
            }
            try { linkSync(stale, lock); } catch { /* Another writer acquired the lock. */ }
          } finally { try { unlinkSync(stale); } catch { /* Already removed. */ } }
        }
      } catch { /* Lock disappeared. */ }
      if (existsSync(lock)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    const store = readStore(path);
    update(store);
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(store)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } finally { try { unlinkSync(temp); } catch { /* Renamed or absent. */ } }
  } finally { unlinkSync(lock); }
}

export function recordInvocation(command: string | undefined, module: string | undefined, cwd = process.cwd(), sessionId = process.env.TERRAFORM_AXI_SESSION_ID): void {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId) || !command || !["plan", "drift", "state", "doctor"].includes(command)) return;
  const modules = configuredModules();
  updateStore((store) => {
    const session = store.active[sessionId] ?? { cwd, commands: {}, modules: {} };
    session.commands[command] = (session.commands[command] ?? 0) + 1;
    if (module && modules.has(module)) session.modules[module] = (session.modules[module] ?? 0) + 1;
    store.active[sessionId] = session;
  });
}

export function recordSession(input: unknown, path = dataPath()): void {
  if (!input || typeof input !== "object") return;
  const sessionId = (input as Record<string, unknown>).session_id;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
  updateStore((store) => {
    const active = store.active[sessionId];
    if (!active) return;
    delete store.active[sessionId];
    store.sessions[sessionId] = { ...active, ended_at: new Date().toISOString() };
    const newest = Object.entries(store.sessions).sort((a, b) => b[1].ended_at.localeCompare(a[1].ended_at)).slice(0, 50);
    store.sessions = Object.fromEntries(newest);
  }, path);
}

export function lastSession(path = dataPath(), cwd = process.cwd()): Session | undefined {
  try {
    const store = readStore(path);
    return Object.values(store.sessions).filter((session) => session.cwd === cwd).sort((a, b) => b.ended_at.localeCompare(a.ended_at))[0];
  } catch { return undefined; }
}
