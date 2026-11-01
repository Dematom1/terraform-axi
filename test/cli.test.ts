import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const root = join(import.meta.dirname, "..");

describe("terraform-axi scaffold", () => {
  it.each(["no-mistakes-required", "guard-generated-files"])(
    "%s gates its release check on both commit identities",
    (workflowName) => {
      const workflowPath = `.github/workflows/${workflowName}.yml`;
      const parseWorkflow = `
        const fs = require("node:fs");
        const yaml = require("js-yaml");
        const workflow = yaml.load(fs.readFileSync(process.argv[1], "utf8"));
        const steps = workflow.jobs.check.steps;
        const release = steps.find((step) => step.id === "release");
        const gate = steps.find((step) => step.if === "steps.release.outputs.bot_only != 'true'");
        process.stdout.write(JSON.stringify({ releaseIf: release.if, releaseRun: release.run, gateIf: gate.if }));
      `;
      const contract: { releaseIf: string; releaseRun: string; gateIf: string } = JSON.parse(
        execFileSync(process.execPath, ["-e", parseWorkflow, workflowPath], { cwd: root, encoding: "utf8" }),
      );
      expect(contract.releaseIf).toBe("github.event.pull_request.user.login == 'release-please[bot]'");
      expect(contract.gateIf).toBe("steps.release.outputs.bot_only != 'true'");

      const fakeBin = mkdtempSync(join(tmpdir(), "release-check-test-"));
      const outputPath = join(fakeBin, "github-output");
      writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\nprintf '%s' \"$GH_FIXTURE\"\n", { mode: 0o700 });
      const checkWorkflow = (commits: string) => {
        writeFileSync(outputPath, "");
        execFileSync("bash", ["-e", "-c", contract.releaseRun], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            GH_FIXTURE: commits,
            GH_TOKEN: "test-token",
            PR_NUMBER: "1",
            REPOSITORY: "example/project",
            GITHUB_OUTPUT: outputPath,
          },
        });
        return readFileSync(outputPath, "utf8").trim();
      };
      try {
        expect(checkWorkflow("release-please[bot]\trelease-please[bot]\n")).toBe("bot_only=true");
        expect(checkWorkflow("human-user\trelease-please[bot]\n")).toBe("bot_only=false");
        expect(checkWorkflow("release-please[bot]\thuman-user\n")).toBe("bot_only=false");
      } finally {
        rmSync(fakeBin, { recursive: true, force: true });
      }
    },
  );

  it("reports that plan is not implemented in the scaffold", async () => {
    const chunks: string[] = [];
    await main(["plan"], { write: (chunk: string) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("not implemented in scaffold");
  });

  it("shows a wrapper version check command when no module is configured", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const wrapper = join(home, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nprintf \'{"terraform_version":"9.9.9"}\\n\'\n', { mode: 0o700 });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "auto", modules: [], wrapper: `${wrapper} {module}` }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain(`via wrapper: not probed; check with: ${wrapper} <module> version -json`);
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
    const wrapper = join(home, "wrapper executable");
    writeFileSync(
      wrapper,
      '#!/bin/sh\ntest "$1" = module-a && test "$2" = version && test "$3" = -json || exit 1\nprintf \'{"terraform_version":"9.9.9"}\\n\'\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "auto", modules: ["module-a"], wrapper: `"${wrapper}" {module}` }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("wrapper: wrapper-selected/unknown 9.9.9");
      expect(output).not.toContain("versions.auto");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not evaluate shell syntax in configured wrappers", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const marker = join(home, "executed");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "auto", modules: ["module-a"], wrapper: `terraform; touch ${marker}` }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("via wrapper: not probed; wrapper command cannot be represented safely");
      expect(existsSync(marker)).toBe(false);
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
