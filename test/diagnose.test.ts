import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, describe, expect, it } from "vitest";
import { safeText } from "../src/commands/diagnose.js";
import { parsePlanEvents } from "../src/plan/events.js";

const cli = join(import.meta.dirname, "..", "dist", "bin", "terraform-axi.js");
const home = mkdtempSync(join(tmpdir(), "tfaxi-diagnose-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const B62 = UPPER + LOWER + DIGITS;
const pick = (alphabet: string, length: number) =>
  Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
const b64url = (length: number) => pick(`${B62}-_`, length);

/**
 * Fresh secret-shaped values per run, so redaction cannot pass by recognizing fixed strings. Each shape is
 * generated rather than committed so secret scanners never see token-shaped literals in the repository.
 */
const pemBody = Array.from({ length: 4 }, () => `MII${pick(`${B62}+/`, 61)}`);
const SECRETS: Record<string, string> = {
  GHP: `ghp_${pick(B62, 36)}`,
  GHO: `gho_${pick(B62, 36)}`,
  PAT: `github_pat_${pick(B62, 22)}_${pick(B62, 59)}`,
  AKID: `AKIA${pick(`${UPPER}234567`, 16)}`,
  AWS_SECRET: pick(`${B62}+/`, 40),
  PEM: ["-----BEGIN RSA PRIVATE KEY-----", ...pemBody, "-----END RSA PRIVATE KEY-----"].join("\n"),
  JWT: `eyJhbGciOiJIUzI1NiJ9.${b64url(48)}.${b64url(43)}`,
  HEX: pick("0123456789abcdef", 64),
  // Letters only, lowercase then uppercase: no plain-word shape can admit it.
  LETTERS: `${pick(LOWER, 1)}${pick(UPPER, 1)}${pick(UPPER + LOWER, 22)}`,
  ACCOUNT: `9${pick(DIGITS, 11)}`,
};
const seeded = [...Object.values(SECRETS), ...pemBody];

function fixture(name: string): string {
  const json = name.endsWith(".jsonl");
  const text = readFileSync(join(import.meta.dirname, "fixtures", "diagnose", name), "utf8").replace(
    /@@(\w+)@@/g,
    (_, key: string) => (json ? JSON.stringify(SECRETS[key]).slice(1, -1) : SECRETS[key]!),
  );
  if (text.includes("@@")) throw new Error(`unfilled placeholder in ${name}`);
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
}

/** Fails on any seeded secret or any 12-character run of one. */
function expectNoLeak(output: string) {
  for (const secret of seeded)
    for (let start = 0; start + 12 <= secret.length; start++)
      if (output.includes(secret.slice(start, start + 12)))
        throw new Error(`leaked ${secret.length}-character secret at offset ${start}`);
}

type Row = Record<string, string | number>;
type Report = Record<string, unknown> & { failures: Row[]; changes: Row[]; help: string[] };

function diagnose(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [cli, "diagnose", ...args], {
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  expectNoLeak(result.stdout + result.stderr);
  return { status: result.status, stdout: result.stdout, data: decode(result.stdout) as Report };
}

describe("diagnose", () => {
  it("leak check catches a seeded secret and every fixture really carries the seeded secrets", () => {
    expect(() => expectNoLeak(`row: ${SECRETS.GHP!.slice(5, 20)}`)).toThrow(/leaked/);
    const inputs = ["github-apply.jsonl", "aws-apply.jsonl", "github-apply.log"].map((name) =>
      readFileSync(fixture(name), "utf8"),
    );
    for (const secret of Object.values(SECRETS))
      expect(
        inputs.some((input) => input.includes(JSON.stringify(secret).slice(1, -1)) || input.includes(secret)),
      ).toBe(true);
  });

  it("attributes a GitHub runner-group apply failure from a JSON stream without values", () => {
    const { status, data } = diagnose([fixture("github-apply.jsonl")]);
    expect(status).toBe(0);
    expect(data).toMatchObject({
      input: "json",
      version: "terraform 1.15.8",
      status: "failed",
      summary: {
        plan: "unavailable",
        apply: "unavailable",
        applied: { complete: 1, errored: 1 },
        errors: 1,
        warnings: 1,
      },
      skipped_text_lines: 1,
    });
    expect(data.failures).toHaveLength(1);
    const row = data.failures[0]!;
    expect(row).toMatchObject({
      address: "github_actions_runner_group.ci",
      provider: "github",
      type: "github_actions_runner_group",
      operation: "create",
      http_status: 404,
      request: "POST /orgs/*/actions/runner-groups",
    });
    expect(row.summary).toContain("404 Not Found");
    expect(row.cause).toContain("runner group");
    expect(row.next).toContain("admin:org");
  });

  it("reports AWS denied actions, error codes, and masked planned addresses", () => {
    const { data } = diagnose([fixture("aws-apply.jsonl")]);
    expect(data.summary).toMatchObject({ plan: { add: 1, change: 1, destroy: 0 }, planned: { create: 1, update: 1 } });
    expect(data.failures[0]).toMatchObject({
      address: "aws_iam_role.deploy",
      provider: "aws",
      operation: "create",
      http_status: 403,
      error_code: "AccessDenied",
      missing_permission: "iam:CreateRole",
    });
    expect(data.failures[0]!.cause).toContain("IAM permission");
    expect(data.changes).toEqual([
      { address: "aws_iam_role.deploy", action: "create", type: "aws_iam_role" },
      {
        address: 'module.keys.aws_secretsmanager_secret_version.this["withheld"]',
        action: "update",
        type: "aws_secretsmanager_secret_version",
      },
    ]);
  });

  it("decodes a plain-text log from stdin best effort without values", () => {
    const { status, data } = diagnose(["-"], readFileSync(fixture("github-apply.log"), "utf8"));
    expect(status).toBe(0);
    expect(data).toMatchObject({
      source: "stdin",
      input: "text",
      status: "failed",
      summary: { plan: { add: 2, change: 0, destroy: 0 }, applied: { complete: 1, errored: 1 }, errors: 1 },
    });
    expect(data.failures[0]).toMatchObject({
      address: "github_actions_runner_group.ci",
      provider: "github",
      operation: "create",
      http_status: 403,
      request: "POST /orgs/*/actions/runner-groups",
    });
    expect(data.failures[0]!.next).toContain("admin:org");
    expect(data.changes.map((change) => change.address)).toEqual([
      'github_actions_organization_secret.ci["withheld"]',
      "github_actions_runner_group.ci",
    ]);
  });

  it("bounds rows with a --full escape hatch and reports unrecognized input truthfully", () => {
    const stream = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({
        type: "planned_change",
        change: { resource: { addr: `terraform_data.r${index}` }, action: "create" },
      }),
    ).join("\n");
    const path = join(home, "many.jsonl");
    writeFileSync(path, stream);
    const bounded = diagnose([path]).data;
    expect(bounded.changes).toHaveLength(25);
    expect(bounded.changes_omitted).toBe(5);
    expect(bounded.help.join(" ")).toContain(`terraform-axi diagnose ${path} --full`);
    expect(diagnose([path, "--full"]).data.changes).toHaveLength(30);
    const unknown = diagnose(["-"], "diagnostics withheld\n").data;
    expect(unknown.status).toBe("unrecognized");
    expect(unknown.failures).toBe("none");
  });

  it("rejects bad usage with exit 2 and unreadable files with exit 1", () => {
    expect(diagnose([]).status).toBe(2);
    expect(diagnose(["a", "b"]).status).toBe(2);
    expect(diagnose(["-", "--bogus"]).status).toBe(2);
    expect(diagnose([join(home, "missing.jsonl")]).status).toBe(1);
  });
});

describe("safeText", () => {
  it("keeps plain words and statuses and drops quoted, bracketed, URL, and token-shaped text", () => {
    expect(
      safeText(`POST https://api.github.com/orgs/acme/x: 403 Resource not accessible by integration [] 'acme' (acme)`),
    ).toBe("POST … 403 Resource not accessible by integration …");
    expect(safeText(`invalid key ${SECRETS.AKID} for user "acme"`)).toBe("invalid key … for user …");
    expect(safeText("Error: invalid token hunter; HTTP 403")).toBe("Error: invalid token … HTTP 403");
    expect(safeText(Array.from({ length: 50 }, () => "word").join(" ")).split(" ")).toHaveLength(41);
  });
});

it("keeps the plan summary separate from an apply summary", () => {
  const events = parsePlanEvents(
    [
      { type: "change_summary", changes: { add: 2, change: 0, remove: 0, operation: "plan" } },
      { type: "change_summary", changes: { add: 1, change: 0, remove: 0, operation: "apply" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  expect(events.summary).toEqual({ add: 2, change: 0, destroy: 0 });
  expect(events.applySummary).toEqual({ add: 1, change: 0, destroy: 0 });
});
