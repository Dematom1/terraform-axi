#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "config.json");
let config: unknown = { binary: "auto", modules: [] };
try {
  config = JSON.parse(readFileSync(path, "utf8"));
} catch {
  /* missing config is a valid first-run state */
}
process.stdout.write(`${encode({ terraform_axi: { config, writes: "never", hints: ["Run terraform-axi setup"] } })}\n`);
