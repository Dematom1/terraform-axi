import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { UsageError, CliError } from "../src/errors.js";
import { assertAllowed, wrapperArgs } from "../src/runner.js";

describe("core boundaries", () => {
  it("rejects invalid CLI values and duplicate non-repeatable flags", () => {
    const options = [
      { name: "--binary", values: ["auto", "terraform", "tofu"] },
      { name: "--module", repeatable: true },
    ];
    for (const argv of [
      ["--bogus"],
      ["--module", "--binary"],
      ["--binary"],
      ["--binary=-5"],
      ["--binary=bad"],
      ["--binary", "tofu", "--binary", "auto"],
    ]) {
      expect(() => parseArgs(argv, options)).toThrow(UsageError);
    }
    expect(parseArgs(["--module=--binary", "--module=-5"], options).values["--module"]).toEqual(["--binary", "-5"]);
  });
  it("preserves a module with spaces as one wrapper argument", () => {
    expect(wrapperArgs("just tf {module}", "infra/a b", ["plan", "-json"])).toEqual([
      "just",
      ["tf", "infra/a b", "plan", "-json"],
    ]);
    for (const invalid of [
      "just tf",
      "just tf {module} {module}",
      "just tf {module}; echo bad",
      "just tf {module}|x",
      "just tf {module}&x",
      "just tf {module}$x",
      "just tf {module}`x`",
      "just tf {module}<x",
      "just tf {module}>x",
      "just tf {module}\\nfoo",
    ]) {
      expect(() => wrapperArgs(invalid, "module", [])).toThrow(CliError);
    }
  });
  it("rejects mutation and output-file arguments before a spawn", () => {
    for (const args of [
      ["apply"],
      ["destroy"],
      ["import"],
      ["init"],
      ["refresh"],
      ["state", "pull"],
      ["state", "push"],
      ["state", "rm"],
      ["state", "mv"],
      ["state", "replace-provider"],
      ["state", "identities"],
      ["workspace", "new"],
      ["workspace", "select"],
      ["workspace", "delete"],
      ["taint"],
      ["untaint"],
      ["force-unlock"],
      ["console"],
      ["login"],
      ["logout"],
      ["test"],
      ["plan", "-out=x"],
      ["plan", "-out", "x"],
      ["show", "saved.tfplan"],
    ])
      expect(() => assertAllowed(args)).toThrow(CliError);
  });
});
