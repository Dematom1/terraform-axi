import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastSession, recordInvocation, recordSession } from "../src/sessions.js";

const originalConfig = process.env.XDG_CONFIG_HOME;
const originalSession = process.env.CLAUDE_SESSION_ID;
let root = "";
afterEach(() => {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  if (originalSession === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSession;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function setup(): string {
  root = mkdtempSync(join(tmpdir(), "terraform-axi-session-"));
  process.env.XDG_CONFIG_HOME = root;
  const dir = join(root, "terraform-axi");
  mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ modules: ["infra/prod"] }));
  return join(dir, "sessions.json");
}

describe("session memory", () => {
  it("records CLI invocations per Claude session without retaining arguments", () => {
    const path = setup();
    process.env.CLAUDE_SESSION_ID = "session_one";
    recordInvocation("plan", "infra/prod");
    recordInvocation("state", "not-configured");
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ message: { content: [{ type: "tool_use", input: { command: "terraform-axi destroy infra/prod" } }] } })}\n`);
    recordSession({ session_id: "session_one", transcript_path: transcript, cwd: process.cwd() }, path);
    const session = lastSession(path);
    expect(session?.commands).toEqual({ plan: 1, state: 1 });
    expect(session?.modules).toEqual({ "infra/prod": 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("sessions[0].args");
  });

  it("keeps simultaneous session records separate", () => {
    const path = setup();
    process.env.CLAUDE_SESSION_ID = "one";
    recordInvocation("plan", "infra/prod");
    process.env.CLAUDE_SESSION_ID = "two";
    recordInvocation("drift", "infra/prod");
    recordSession({ session_id: "two" }, path);
    recordSession({ session_id: "one" }, path);
    const sessions = JSON.parse(readFileSync(path, "utf8")).sessions;
    expect(sessions.map((session: { session_id: string }) => session.session_id)).toEqual(["two", "one"]);
  });
});
