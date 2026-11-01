import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_ARGS, scrub } from "../src/plan/command.js";
import { parsePlanFile } from "../src/plan/show.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "dist", "bin", "terraform-axi.js");
const fake = join(import.meta.dirname, "fixtures", "fake-terraform.mjs");
const planFixture = (name: string) => join(import.meta.dirname, "fixtures", "plan", name);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tfaxi-plan-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Runs the built CLI with a scrubbed environment: no inherited cloud credentials. */
function tfaxi(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env },
  });
  return { status: result.status, stdout: result.stdout, report: decode(result.stdout) as Record<string, unknown> };
}
/** Configures a wrapper that replays a captured plan stream instead of running Terraform. */
function withFakeWrapper(): string {
  mkdirSync(join(home, ".config", "terraform-axi"), { recursive: true });
  writeFileSync(
    join(home, ".config", "terraform-axi", "config.json"),
    JSON.stringify({ binary: "auto", modules: [], wrapper: `${process.execPath} ${fake} {module}` }),
  );
  return join(home, "calls.jsonl");
}
const calls = (log: string) =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
const changeRows = (report: Record<string, unknown>) =>
  Object.fromEntries(
    (report.changes as { address: string; action: string; flags: string; reason: string }[]).map((row) => [
      row.address,
      [row.action, row.flags, row.reason].filter(Boolean).join(" | "),
    ]),
  );

describe.each([
  ["terraform", "1.15.8"],
  ["tofu", "1.13.1"],
])("captured %s %s show -json document", (_flavor, version) => {
  it("decodes every action with the stream's reason words and Terraform's counts", () => {
    const events = parsePlanFile(readFileSync(planFixture(`${_flavor}-${version}-show.json`), "utf8"));
    expect(Object.fromEntries(events.changes.map((row) => [row.address, [row.action, row.reason ?? ""]]))).toEqual({
      "data.terraform_remote_state.deferred": ["read", "read_because_dependency_pending"],
      "terraform_data.forgotten": ["forget", "delete_because_no_resource_config"],
      "terraform_data.gone": ["DESTROY", "delete_because_no_resource_config"],
      "terraform_data.imported": ["import", ""],
      "terraform_data.keep": ["update", ""],
      "terraform_data.moved": ["move", ""],
      "terraform_data.new": ["create", ""],
      "terraform_data.repl": ["REPLACE", "cannot_update"],
    });
    // The same module planned live printed "Plan: 1 to import, 2 to add, 1 to change, 2 to destroy."
    expect(events.summary).toEqual({ add: 2, change: 1, destroy: 2, import: 1, forget: 1 });
    expect(events.outputs).toEqual([{ name: "token", action: "update", sensitive: true }]);
  });

  it("passes and fails --expect from the CLI without printing sensitive values", () => {
    const file = planFixture(`${_flavor}-${version}-show.json`);
    const pass = tfaxi(["plan", "--plan-json", file, "--expect", "add=2,change=1,destroy=2"]);
    expect(pass.status).toBe(0);
    expect(pass.report.expect).toEqual({ status: "pass" });
    const fail = tfaxi(["plan", "--plan-json", file, "--expect", "destroy=0"]);
    expect(fail.status).toBe(1);
    expect(fail.report.expect).toEqual({
      status: "fail",
      reasons: [
        "destroy: expected 0, planned 2 (terraform_data.gone DESTROY delete_because_no_resource_config, terraform_data.repl REPLACE cannot_update)",
      ],
    });
    for (const output of [pass.stdout, fail.stdout]) expect(output).not.toContain("SENTINEL");
  });
});

describe("plan --plan-json risk flags", () => {
  it("flags destroys, replacements, IAM, secrets, sensitive outputs, and unknown actions", () => {
    const { status, report, stdout } = tfaxi(["plan", "--plan-json", planFixture("risk-flags-show.json")]);
    expect(changeRows(report)).toEqual({
      "aws_s3_bucket.logs": "DESTROY | destroy | delete_because_no_resource_config",
      "aws_instance.web": "REPLACE | destroy replace(tainted) | tainted",
      "aws_iam_role.deploy": "create | iam",
      "aws_iam_policy.ro": "DESTROY | destroy iam",
      "aws_secretsmanager_secret_version.db": "update | secret",
      "future_thing.x": 'unknown | unknown | unrecognized action ["teleport"]',
      "output.db_password": "create | secret",
      "data.aws_iam_policy_document.ro": "read",
    });
    expect(report.risk).toEqual({ high: 7, low: 1 });
    expect(report.drift).toEqual([{ address: "aws_s3_bucket.logs", action: "update", type: "aws_s3_bucket" }]);
    // An action that cannot be counted makes the counts unavailable, never a guess, and fails the command.
    expect(report.summary).toBe("unavailable");
    expect(report.status).toBe("incomplete");
    expect(status).toBe(1);
    expect(stdout).not.toContain("SENTINEL");
  });

  it.each([
    [
      "a state document",
      JSON.stringify({ format_version: "1.0", values: { root_module: {} } }),
      "not a Terraform plan",
    ],
    ["a non-plan JSON value", "[1,2]", "not a Terraform plan"],
  ])("rejects %s", (_name, contents, message) => {
    const file = join(home, "input.json");
    writeFileSync(file, contents);
    const { status, report } = tfaxi(["plan", "--plan-json", file]);
    expect(status).toBe(1);
    expect(String(report.error)).toContain(message);
  });

  it("treats an errored plan document as incomplete", () => {
    const file = join(home, "errored.json");
    writeFileSync(file, JSON.stringify({ format_version: "1.2", planned_values: {}, errored: true }));
    const { status, report } = tfaxi(["plan", "--plan-json", file, "--expect", "add=0"]);
    expect(status).toBe(1);
    expect(report.summary).toBe("unavailable");
    expect(report.expect).toEqual({
      status: "fail",
      reasons: ["planned counts unavailable: the plan has no complete change summary"],
    });
  });

  it("caps low-risk rows unless --full is given", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        type: "planned_change",
        change: { resource: { addr: `terraform_data.n${i}`, resource_type: "terraform_data" }, action: "create" },
      }),
    );
    lines.push(JSON.stringify({ type: "change_summary", changes: { add: 30, change: 0, remove: 0 } }));
    const file = join(home, "many.jsonl");
    writeFileSync(file, lines.join("\n"));
    const capped = tfaxi(["plan", "--plan-json", file]);
    expect(capped.status).toBe(0);
    expect(capped.report.changes).toHaveLength(25);
    expect(capped.report.low_risk_omitted).toBe(5);
    const all = tfaxi(["plan", "--full", "--plan-json", file]);
    expect(all.report.changes).toHaveLength(30);
    expect(all.report.low_risk_omitted).toBeUndefined();
  });
});

describe("plan <module> through the configured runner", () => {
  it("runs the exact read-only plan argv, treats exit 2 as changes present, and strips TF_CLI_ARGS", () => {
    const log = withFakeWrapper();
    const { status, report } = tfaxi(["plan", "infra/prod", "--expect", "add=4,change=2,destroy=4"], {
      TF_AXI_CALL_LOG: log,
      TF_AXI_FIXTURE: planFixture("terraform-1.15.8-changes.jsonl"),
      TF_AXI_EXIT_CODE: "2",
      TF_CLI_ARGS: "-auto-approve",
      TF_CLI_ARGS_plan: `-out=${join(home, "leak.tfplan")}`,
    });
    expect(status).toBe(0);
    expect(report).toMatchObject({
      module: "infra/prod",
      via: "wrapper",
      status: "planned",
      expect: { status: "pass" },
    });
    const [call, ...rest] = calls(log);
    expect(rest).toEqual([]);
    expect(call!.argv).toEqual(["infra/prod", ...PLAN_ARGS]);
    expect(Object.keys(call!.env).filter((key) => key.startsWith("TF_CLI_ARGS"))).toEqual([]);
    expect(existsSync(join(home, "leak.tfplan"))).toBe(false);
    // The apply command is printed for a human with the wrapper, never run.
    expect(report.help).toContain(
      `terraform-axi never applies; a human may run: \`${process.execPath} ${fake} infra/prod apply\``,
    );
  });

  it("fails --expect with reasons naming the contributing resources", () => {
    withFakeWrapper();
    const { status, report } = tfaxi(["plan", "infra/prod", "--expect", "add=4,change=2,destroy=0"], {
      TF_AXI_FIXTURE: planFixture("tofu-1.13.1-changes.jsonl"),
      TF_AXI_EXIT_CODE: "2",
    });
    expect(status).toBe(1);
    expect(report.version).toBe("tofu 1.13.1");
    expect(report.expect).toEqual({
      status: "fail",
      reasons: [
        "destroy: expected 0, planned 4 (terraform_data.gone DESTROY delete_because_no_resource_config, terraform_data.cbd REPLACE cannot_update, terraform_data.repl REPLACE cannot_update, terraform_data.triggered REPLACE replace_triggered_by)",
      ],
    });
  });

  it("passes a no-change plan", () => {
    withFakeWrapper();
    const { status, report } = tfaxi(["plan", "m", "--expect", "add=0,change=0,destroy=0"], {
      TF_AXI_FIXTURE: planFixture("terraform-1.15.8-no-change.jsonl"),
    });
    expect(status).toBe(0);
    expect(report).toMatchObject({ status: "planned", changes: "none", expect: { status: "pass" } });
    expect(JSON.stringify(report.help ?? [])).not.toContain("apply");
  });

  it("reports plan errors with diagnostics and masks credential values", () => {
    withFakeWrapper();
    const secret = "fixture-only-value-123";
    const { status, report, stdout } = tfaxi(["plan", "m"], {
      TF_AXI_FIXTURE: planFixture("terraform-1.15.8-error.jsonl"),
      TF_AXI_EXIT_CODE: "1",
      TF_AXI_STDERR: `backend said ${secret}\n`,
      AWS_SECRET_ACCESS_KEY: secret,
    });
    expect(status).toBe(1);
    expect(report.status).toBe("error");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", summary: "Reference to undeclared resource" }),
    ]);
    expect(report.stderr).toEqual(["backend said [redacted]"]);
    expect(stdout).not.toContain(secret);
  });

  it("fails a truncated stream as incomplete instead of trusting partial rows", () => {
    withFakeWrapper();
    const { status, report } = tfaxi(["plan", "m"], {
      TF_AXI_FIXTURE: planFixture("terraform-1.15.8-truncated.jsonl"),
      TF_AXI_EXIT_CODE: "2",
    });
    expect(status).toBe(1);
    expect(report).toMatchObject({ status: "incomplete", malformed_lines: 1 });
  });

  it("runs the raw binary with --binary, bypassing the configured wrapper", () => {
    const log = withFakeWrapper();
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tofu"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = version ] && { printf '{"terraform_version":"1.13.1"}\\n'; exit 0; }\ncat '${planFixture("tofu-1.13.1-changes.jsonl")}'\nexit 2\n`,
      { mode: 0o700 },
    );
    const { status, report } = tfaxi(["plan", home, "--binary", "tofu"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(status).toBe(0);
    expect(report.via).toBeUndefined();
    expect(report.version).toBe("tofu 1.13.1");
    expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toBe(`-chdir=${home} ${PLAN_ARGS.join(" ")}`);
    expect(report.help).toContain(`terraform-axi never applies; a human may run: \`tofu -chdir=${home} apply\``);
  });

  it("kills a plan that outlives --timeout", () => {
    mkdirSync(join(home, ".config", "terraform-axi"), { recursive: true });
    const slow = join(home, "slow");
    writeFileSync(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
    writeFileSync(
      join(home, ".config", "terraform-axi", "config.json"),
      JSON.stringify({ binary: "auto", modules: [], wrapper: `${slow} {module}` }),
    );
    const started = Date.now();
    const { status, report } = tfaxi(["plan", "m", "--timeout", "1"]);
    expect(status).toBe(1);
    expect(report.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("fails a nonzero exit even when the stream looks complete", () => {
    withFakeWrapper();
    const { status, report } = tfaxi(["plan", "m"], {
      TF_AXI_FIXTURE: planFixture("terraform-1.15.8-no-change.jsonl"),
      TF_AXI_EXIT_CODE: "1",
    });
    expect(status).toBe(1);
    expect(report).toMatchObject({ status: "error", exit_code: 1 });
  });

  it("fails a wrapper error that prints no plan, showing its stderr", () => {
    withFakeWrapper();
    const { status, report } = tfaxi(["plan", "m"], {
      TF_AXI_EXIT_CODE: "1",
      TF_AXI_STDERR: "recipe `tf` not found\n",
    });
    expect(status).toBe(1);
    expect(report).toMatchObject({ status: "error", exit_code: 1, stderr: ["recipe `tf` not found"] });
  });

  it.each([
    [["plan"], "plan needs a module or --plan-json"],
    [["plan", "m", "--plan-json", "x.json"], "not both"],
    [["plan", "m", "extra"], "unexpected plan argument"],
    [["plan", "m", "--expect", "add=-1"], "negative"],
    [["plan", "m", "--expect", "remove=1"], 'key "remove" is unknown'],
    [["plan", "m", "--timeout", "0"], "--timeout must be a whole number"],
    [["plan", "m", "--timeout", "1.5"], "--timeout must be a whole number"],
    [["plan", "m", "--binary", "auto"], "invalid value for --binary"],
    [["plan", "--plan-json", "x.json", "--binary", "tofu"], "apply only to plan <module>"],
  ])("rejects %j before running anything", (args, message) => {
    const log = withFakeWrapper();
    const { status, report } = tfaxi(args, { TF_AXI_CALL_LOG: log });
    expect(status).toBe(2);
    expect(String(report.error)).toContain(message);
    expect(existsSync(log)).toBe(false);
  });
});

describe("scrub", () => {
  it("masks credential-like environment values only", () => {
    const env = { AWS_SECRET_ACCESS_KEY: "abcdef123", B2_APPLICATION_KEY: "b2keyvalue", HOME: "/home/user" };
    expect(scrub("x abcdef123 b2keyvalue /home/user", env)).toBe("x [redacted] [redacted] /home/user");
  });
});
