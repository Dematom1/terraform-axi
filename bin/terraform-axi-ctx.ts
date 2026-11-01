#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isatty } from "node:tty";
import { isSessionId, lastSession, sessionKey } from "../src/sessions.js";
const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "config.json");
let config: { binary: "terraform" | "tofu" | "auto"; modules: string[] } = { binary: "auto", modules: [] };
try {
  const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const value = saved as Record<string, unknown>;
    config = {
      binary: value.binary === "terraform" || value.binary === "tofu" ? value.binary : "auto",
      modules:
        Array.isArray(value.modules) && value.modules.every((module) => typeof module === "string")
          ? value.modules
          : [],
    };
  }
} catch {
  /* missing config is a valid first-run state */
}
let sessionId: string | undefined;
if (!isatty(0))
  try {
    const input: unknown = JSON.parse(readFileSync(0, "utf8"));
    if (input && typeof input === "object" && isSessionId((input as Record<string, unknown>).session_id))
      sessionId = (input as { session_id: string }).session_id;
  } catch {
    /* no hook input */
  }
// Claude Code sources CLAUDE_ENV_FILE before each Bash call, so later CLI runs see the session id.
if (sessionId && process.env.CLAUDE_ENV_FILE) {
  try {
    appendFileSync(process.env.CLAUDE_ENV_FILE, `export TERRAFORM_AXI_SESSION=${sessionId}\n`);
  } catch {
    /* session memory falls back to unkeyed records */
  }
}
const last = lastSession(sessionKey(sessionId));
process.stdout.write(
  `${encode({ terraform_axi: { binary: config.binary, modules: config.modules, ...(last ? { last_session: last } : {}), writes: "never" } })}\n`,
);
