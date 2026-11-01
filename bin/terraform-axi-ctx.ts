#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lastSession } from "../src/sessions.js";
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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const value: unknown = JSON.parse(input);
    if (value && typeof value === "object" && "session_id" in value && typeof value.session_id === "string" && /^[a-zA-Z0-9_-]+$/.test(value.session_id) && process.env.CLAUDE_ENV_FILE)
      appendFileSync(process.env.CLAUDE_ENV_FILE, `export TERRAFORM_AXI_SESSION_ID='${value.session_id}'\n`, { mode: 0o600 });
  } catch {}
  process.stdout.write(`${encode({ terraform_axi: { binary: config.binary, modules: config.modules, last_session: lastSession(), writes: "never" } })}\n`);
});
