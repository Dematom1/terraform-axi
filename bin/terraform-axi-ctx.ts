#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
process.stdout.write(`${encode({ terraform_axi: { config, writes: "never", hints: ["Run terraform-axi setup"] } })}\n`);
