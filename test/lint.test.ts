import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, expect, it } from "vitest";

const cli = join(import.meta.dirname, "..", "dist", "bin", "terraform-axi.js");
let home: string;
let module: string;
let bin: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tfaxi-lint-"));
  module = join(home, "module");
  bin = join(home, "bin");
  mkdirSync(module);
  mkdirSync(bin);
  writeFileSync(join(module, "main.tf"), "terraform {}\n");
  stub(
    "terraform",
    `const args = process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(join(home, "calls"))}, JSON.stringify({args, injected: process.env.TF_CLI_ARGS})+'\\n');\nif (args.includes('fmt')) { console.log(process.env.FMT_OUTPUT || ''); process.exit(Number(process.env.FMT_EXIT || 0)); }\nif (args.includes('validate')) { console.log(process.env.VALIDATE_OUTPUT || '{"valid":true,"diagnostics":[]}'); process.exit(Number(process.env.VALIDATE_EXIT || 0)); }\nthrow Error('unexpected command');`,
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
}
function lint(args: string[] = [module, "--binary", "terraform"], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, "lint", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: bin, ...env },
  });
  return { status: result.status, report: decode(result.stdout) };
}
it("reports both skips, never initializes, and uses non-writing fmt flags with injected flags stripped", () => {
  expect(lint(undefined, { TF_CLI_ARGS: "-write=true", TF_CLI_ARGS_fmt: "-write=true" })).toMatchObject({
    status: 0,
    report: {
      count: 0,
      checks: [
        { check: "fmt", status: "passed" },
        { check: "validate", status: "skipped" },
        { check: "tflint", status: "skipped" },
      ],
    },
  });
  expect(
    readFileSync(join(home, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([{ args: [`-chdir=${module}`, "fmt", "-check", "-no-color"] }]);
  expect(readdirSync(module)).toEqual(["main.tf"]);
  expect(readFileSync(join(module, "main.tf"), "utf8")).toBe("terraform {}\n");
});
it("counts unformatted files as errors without claiming validate passed", () => {
  expect(lint(undefined, { FMT_EXIT: "3", FMT_OUTPUT: "main.tf\nother.tf" })).toMatchObject({
    status: 1,
    report: {
      count: 2,
      findings: [
        { file: "main.tf", line: null, rule: "fmt", severity: "error" },
        { file: "other.tf", rule: "fmt" },
      ],
    },
  });
});
it("reports located validate errors in initialized modules even when fmt fails", () => {
  mkdirSync(join(module, ".terraform"));
  expect(
    lint(undefined, {
      FMT_EXIT: "2",
      VALIDATE_EXIT: "1",
      VALIDATE_OUTPUT: JSON.stringify({
        valid: false,
        diagnostics: [
          {
            severity: "error",
            summary: "Bad reference",
            detail: "Unknown resource",
            range: { filename: "main.tf", start: { line: 4 } },
          },
        ],
      }),
    }),
  ).toMatchObject({
    status: 1,
    report: {
      count: 2,
      checks: [{ status: "error" }, { status: "error" }, { status: "skipped" }],
      findings: [
        { rule: "fmt" },
        { file: "main.tf", line: 4, rule: "validate", severity: "error", message: "Bad reference: Unknown resource" },
      ],
    },
  });
});
it("honors TF_DATA_DIR and fails closed on malformed validation output", () => {
  mkdirSync(join(module, "data"));
  expect(lint(undefined, { TF_DATA_DIR: "data", VALIDATE_OUTPUT: "{}" })).toMatchObject({
    status: 1,
    report: { findings: [{ rule: "validate", severity: "error" }] },
  });
});
it.each(["WARNING", "ERROR", "INFO"])("runs installed tflint and retains %s severity", (inputSeverity) => {
  const severity = inputSeverity.toLowerCase();
  stub(
    "tflint",
    `console.log(${JSON.stringify(JSON.stringify({ issues: [{ rule: { name: "terraform_unused_declarations", severity: inputSeverity }, message: "Unused variable", range: { filename: "main.tf", start: { line: 1 } } }], errors: [] }))}); process.exit(2);`,
  );
  expect(lint()).toMatchObject({
    status: severity === "error" ? 1 : 0,
    report: {
      count: 1,
      findings: [
        { file: "main.tf", line: 1, rule: "terraform_unused_declarations", severity, message: "Unused variable" },
      ],
    },
  });
});
it.each([undefined, null, { filename: "", start: { line: 0 } }])(
  "preserves validation warnings with unavailable range %j and omitted detail",
  (range) => {
    mkdirSync(join(module, ".terraform"));
    expect(
      lint(undefined, {
        VALIDATE_OUTPUT: JSON.stringify({
          valid: true,
          diagnostics: [{ severity: "warning", summary: "Module warning", range }],
        }),
      }),
    ).toMatchObject({
      status: 0,
      report: {
        count: 1,
        findings: [{ file: null, line: null, rule: "validate", severity: "warning", message: "Module warning" }],
      },
    });
  },
);
it("preserves module-level TFLint findings without a source location", () => {
  stub(
    "tflint",
    `console.log(${JSON.stringify(JSON.stringify({ issues: [{ rule: { name: "terraform_required_version", severity: "warning" }, message: "Missing required_version", range: { filename: "", start: { line: 0 } } }], errors: [] }))}); process.exit(2);`,
  );
  expect(lint()).toMatchObject({
    status: 0,
    report: {
      count: 1,
      findings: [
        {
          file: null,
          line: null,
          rule: "terraform_required_version",
          severity: "warning",
          message: "Missing required_version",
        },
      ],
    },
  });
});
it("still rejects validation detail with an invalid type", () => {
  mkdirSync(join(module, ".terraform"));
  expect(
    lint(undefined, {
      VALIDATE_OUTPUT: JSON.stringify({
        valid: true,
        diagnostics: [{ severity: "warning", summary: "Module warning", detail: 7 }],
      }),
    }),
  ).toMatchObject({ status: 1, report: { findings: [{ severity: "error", message: "invalid diagnostic text" }] } });
});
it("treats installed tflint execution failures as errors, not skips", () => {
  stub("tflint", "process.exit(1)");
  expect(lint()).toMatchObject({
    status: 1,
    report: { checks: [{}, {}, { status: "error" }], findings: [{ rule: "tflint", severity: "error" }] },
  });
});
it("rejects unknown flags and missing modules", () => {
  expect(lint([]).status).toBe(2);
  expect(lint([module, "--init"]).status).toBe(2);
});
