#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isatty } from "node:tty";
import { captureSession, lastCapture, scopedModules } from "../src/capture.js";
import { isSessionId } from "../src/sessions.js";
import { defaults, readConfig } from "../src/config.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(
    `${encode({ usage: "terraform-axi-ctx [--capture]", flags: ["--capture: explicit session-end capture from stdin JSON", "--help"], defaults: "read-only directory-scoped context", examples: ["terraform-axi-ctx", "terraform-axi-ctx --capture < event.json"] })}\n`,
  );
} else if (args.length > 1 || (args.length === 1 && args[0] !== "--capture")) {
  process.stdout.write(
    `${encode({ code: "VALIDATION_ERROR", error: "expected no arguments or --capture", help: ["Run `terraform-axi-ctx --help` for valid flags"] })}\n`,
  );
  process.exitCode = 2;
} else {
  let input: unknown = {};
  if (!isatty(0)) {
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      /* no hook input */
    }
  }
  if (process.argv.includes("--capture")) {
    try {
      captureSession(input);
      process.stdout.write(`${encode({ captured: true })}\n`);
    } catch (error) {
      process.stdout.write(
        `${encode({ error: error instanceof Error ? error.message : "capture failed", help: ["Check the hook session_id, cwd and readable transcript_path, then retry the capture action"] })}\n`,
      );
      process.exitCode = 1;
    }
  } else {
    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "terraform-axi", "config.json");
    let config = defaults;
    try {
      config = readConfig(path);
    } catch {
      /* optional ambient context tolerates missing or invalid config */
    }
    const sessionId =
      input && typeof input === "object" && "session_id" in input && isSessionId(input.session_id)
        ? input.session_id
        : undefined;
    const last = lastCapture(process.cwd(), sessionId);
    process.stdout.write(
      `${encode({ terraform_axi: { binary: config.binary, modules: scopedModules(config.modules, process.cwd(), config.moduleDirectories), ...(last ? { last_session: last } : {}), writes: "never" } })}\n`,
    );
  }
}
