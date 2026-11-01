import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { UsageError, CliError } from "../src/errors.js";
import { assertAllowed } from "../src/runner.js";

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
  });
  it("rejects mutation and output-file arguments before a spawn", () => {
    for (const args of [["apply"], ["destroy"], ["plan", "-out=x"]])
      expect(() => assertAllowed(args)).toThrow(CliError);
  });
});
