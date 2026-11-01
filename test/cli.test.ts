import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const root = join(import.meta.dirname, "..");

describe("terraform-axi scaffold", () => {
  it.each(["no-mistakes-required", "guard-generated-files"])(
    "%s skips only all-bot release commits",
    () => {
      const script = join(root, "scripts", "release-bot-only.mjs");
      const check = (authors: string[]) =>
        execFileSync(process.execPath, [script], { encoding: "utf8", input: `${authors.join("\n")}\n` });

      expect(check(["release-please[bot]", "release-please[bot]"])).toBe("true");
      expect(check(["release-please[bot]", "human-user"])).toBe("false");
      expect(check([])).toBe("false");
    },
  );

  it("reports that plan is not implemented in the scaffold", async () => {
    const chunks: string[] = [];
    await main(["plan"], { write: (chunk: string) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("not implemented in scaffold");
  });

  it("probes versions through the configured wrapper", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const wrapper = join(home, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nprintf \'{"terraform_version":"9.9.9"}\\n\'\n', { mode: 0o700 });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ binary: "auto", modules: [], wrapper }));
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain(
        "via wrapper: not probed; no exact check command is available without a configured module",
      );
      expect(output).not.toContain("versions.auto");
      expect(output).not.toContain("9.9.9");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("probes a configured module through wrapper argv", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const wrapper = join(home, "wrapper");
    writeFileSync(
      wrapper,
      '#!/bin/sh\ntest "$1" = module-a && test "$2" = version && test "$3" = -json || exit 1\nprintf \'{"terraform_version":"9.9.9"}\\n\'\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "auto", modules: ["module-a"], wrapper: `${wrapper} {module}` }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("wrapper: Terraform/OpenTofu 9.9.9");
      expect(output).not.toContain("versions.auto");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores an invalid saved modules value in the built CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"modules":null}');
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("modules: none configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
