import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlanEvents } from "../src/plan/events.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "dist", "bin", "terraform-axi.js");
const fake = join(import.meta.dirname, "fixtures", "fake-terraform.mjs");
const fixture = (name: string) => join(import.meta.dirname, "fixtures", "plan", `${name}.jsonl`);

let home: string;
let callLog: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tfaxi-drift-"));
  callLog = join(home, "calls.jsonl");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function configure(settings: object) {
  mkdirSync(join(home, ".config", "terraform-axi"), { recursive: true });
  writeFileSync(join(home, ".config", "terraform-axi", "config.json"), JSON.stringify(settings));
}
const withWrapper = () => configure({ binary: "auto", modules: [], wrapper: `${process.execPath} ${fake} {module}` });

/** Runs the built CLI with an allowlisted env: no inherited cloud credentials or TF_* variables. */
function drift(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, "drift", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TF_AXI_CALL_LOG: callLog,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, output: decode(result.stdout) as Record<string, unknown> };
}
const calls = () =>
  readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });

describe.each(["terraform-1.15.8", "tofu-1.13.1"])("drift on captured %s streams", (prefix) => {
  it("counts resource_drift events even though change_summary is 0/0/0", () => {
    // Regression guard: a refresh-only plan's summary never counts drift.
    expect(parsePlanEvents(readFileSync(fixture(`${prefix}-drift`), "utf8")).summary).toMatchObject({
      add: 0,
      change: 0,
      destroy: 0,
    });
    withWrapper();
    const { status, output } = drift(["infra/a b"], { TF_AXI_FIXTURE: fixture(`${prefix}-drift`) });
    expect(status).toBe(0);
    expect(output).toMatchObject({
      module: "infra/a b",
      status: "drift detected",
      drifted: 1,
      drift: [{ action: "delete", address: "local_file.drifted" }],
      human_only: `${process.execPath} ${fake} 'infra/a b' apply -refresh-only`,
    });
    expect(output.version).toMatch(/^(terraform 1\.15\.8|tofu 1\.13\.1)$/);
    expect(output.via).toBe("wrapper");
  });

  it("treats -detailed-exitcode 2 as drift present, not a failure", () => {
    withWrapper();
    const { status, output } = drift(["m"], { TF_AXI_FIXTURE: fixture(`${prefix}-drift`), TF_AXI_EXIT_CODE: "2" });
    expect(status).toBe(0);
    expect(output).toMatchObject({ status: "drift detected", drifted: 1 });
  });

  it("reports a clean stream as no drift without a human_only command", () => {
    withWrapper();
    const { status, output } = drift(["m"], { TF_AXI_FIXTURE: fixture(`${prefix}-no-change`) });
    expect(status).toBe(0);
    expect(output).toMatchObject({ status: "no drift", drifted: 0 });
    expect(output).not.toHaveProperty("human_only");
    expect(output).not.toHaveProperty("drift");
    expect(output.help).toEqual(["Run `terraform-axi plan m` to see planned configuration changes"]);
  });

  it("fails with the plan's diagnostics on an error stream", () => {
    withWrapper();
    const { status, output } = drift(["m"], { TF_AXI_FIXTURE: fixture(`${prefix}-error`), TF_AXI_EXIT_CODE: "1" });
    expect(status).toBe(1);
    expect(output).toMatchObject({
      status: "error",
      exit_code: 1,
      diagnostics: [{ severity: "error", category: "terraform_diagnostic" }],
    });
    expect(output).not.toHaveProperty("drifted");
  });

  it("refuses a truncated stream instead of reporting no drift", () => {
    withWrapper();
    const { status, output } = drift(["m"], { TF_AXI_FIXTURE: fixture(`${prefix}-truncated`) });
    expect(status).toBe(1);
    expect(output.status).toBe("incomplete");
    expect(output).not.toHaveProperty("drifted");
  });
});

describe("drift invocation", () => {
  it("runs a refresh-only, lock-free plan that never refreshes state or writes a plan file", () => {
    withWrapper();
    drift(["m"], { TF_AXI_FIXTURE: fixture("terraform-1.15.8-no-change"), TF_CLI_ARGS_plan: "-out=leak" });
    const [call] = calls();
    expect(call!.argv).toEqual([
      "m",
      "plan",
      "-json",
      "-input=false",
      "-lock=false",
      "-detailed-exitcode",
      "-refresh-only",
    ]);
    expect(call!.env).not.toHaveProperty("TF_CLI_ARGS_plan");
    expect(call!.argv).not.toContain("refresh");
    expect(call!.argv.some((arg) => arg === "-out" || arg.startsWith("-out="))).toBe(false);
  });

  it("passes no inherited cloud credentials or TF_* variables to the child", () => {
    withWrapper();
    drift(["m"], { TF_AXI_FIXTURE: fixture("terraform-1.15.8-no-change") });
    const keys = Object.keys(calls()[0]!.env);
    expect(keys.filter((key) => /^(AWS|B2|ARM|GOOGLE)_/.test(key))).toEqual([]);
    expect(keys.filter((key) => key.startsWith("TF_") && !key.startsWith("TF_AXI_")).sort()).toEqual([
      "TF_INPUT",
      "TF_IN_AUTOMATION",
    ]);
  });

  it("builds human_only from the selected binary and module directory", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "terraform"), `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`, { mode: 0o700 });
    const module = join(home, "my module");
    mkdirSync(module);
    configure({ binary: "auto", modules: [] });
    const { status, output } = drift([module, "--binary", "terraform"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TF_AXI_FIXTURE: fixture("terraform-1.15.8-drift"),
    });
    expect(status).toBe(0);
    expect(output.human_only).toBe(`terraform '-chdir=${module}' apply -refresh-only`);
    expect(calls()[0]!.argv.slice(0, 2)).toEqual([`-chdir=${module}`, "plan"]);
  });

  it("bounds drift rows and says how many were left out", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({
        type: "resource_drift",
        change: { resource: { addr: `local_file.f${i}`, resource_type: "local_file" }, action: "update" },
      }),
    );
    const stream = join(home, "many.jsonl");
    writeFileSync(
      stream,
      [...events, JSON.stringify({ type: "change_summary", changes: { add: 0, change: 0, remove: 0 } })].join("\n"),
    );
    withWrapper();
    const { output } = drift(["m"], { TF_AXI_FIXTURE: stream });
    expect(output).toMatchObject({ drifted: 25, truncated: "showing 20 of 25" });
    expect(output.drift).toHaveLength(20);
  });

  it("rejects a missing module as a usage error before spawning", () => {
    withWrapper();
    const { status, output } = drift([]);
    expect(status).toBe(2);
    expect(String(output.error)).toContain("usage: terraform-axi drift <module>");
    expect(() => readFileSync(callLog)).toThrow();
  });
});
