import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("terraform-axi scaffold", () => {
  it("prepares the npm stage CLI before enabling OIDC for publish", () => {
    const workflowPath = ".github/workflows/release-please.yml";
    const inspectWorkflow = `
      const fs = require("node:fs");
      const yaml = require("js-yaml");
      const jobs = yaml.load(fs.readFileSync(process.argv[1], "utf8")).jobs;
      const build = jobs.build;
      const publish = jobs.publish;
      const artifact = build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
      const download = publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
      process.stdout.write(JSON.stringify({
        buildHasNoOidc: build.permissions?.["id-token"] !== "write",
        publishHasOidc: publish.permissions["id-token"] === "write",
        packageArtifact: artifact?.with?.name === "package" && artifact.with.path.includes("terraform-axi-*.tgz") && artifact.with.path.includes("npm-cli.tgz"),
        matchingDownload: download?.with?.name === artifact?.with?.name,
        buildStepOrder: build.steps.indexOf(artifact) > 0,
        publishSteps: publish.steps.map((step) => step.name ?? step.uses ?? "run"),
      }));
    `;
    const result: Record<string, boolean> = JSON.parse(
      execFileSync(process.execPath, ["-e", inspectWorkflow, workflowPath], { cwd: root, encoding: "utf8" }),
    );
    expect(result).toEqual({
      buildHasNoOidc: true,
      publishHasOidc: true,
      packageArtifact: true,
      matchingDownload: true,
      buildStepOrder: true,
      publishSteps: [
        "Validate manual publish ref",
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
        "run",
        "Skip if version already exists",
        "Stage package for approval",
      ],
    });
  });

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
      const fakeGh = join(fakeBin, "gh");
      const outputPath = join(fakeBin, "github-output");
      writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s' \"$GH_FIXTURE\"\n", { mode: 0o700 });
      const run = contract.releaseRun
        .replace("gh api", `${JSON.stringify(fakeGh)} api`)
        .replace(
          "node scripts/release-bot-only.mjs",
          `${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "scripts/release-bot-only.mjs"))}`,
        );
      const checkWorkflow = (commits: string) => {
        writeFileSync(outputPath, "");
        execFileSync("bash", ["-e", "-c", run], {
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

  it("keeps saved wrapper values out of SessionStart context", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-context-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "tofu", modules: ["safe-module"], wrapper: "secret-token" }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi-ctx.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("tofu");
      expect(output).toContain("safe-module");
      expect(output).not.toContain("secret-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails with NOT_IMPLEMENTED when plan is not implemented", () => {
    const result = spawnSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js"), "plan", "test-module"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("NOT_IMPLEMENTED");
  });

  it("reports an unprobed wrapper without a module or suggested command", () => {
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
      expect(output).toContain("wrapper: not probed (no module configured)");
      expect(output).not.toContain("<module>");
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

  it("does not probe a configured wrapper without a module placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const marker = join(home, "executed");
    const wrapper = join(home, "wrapper");
    writeFileSync(wrapper, `#!/bin/sh\ntouch "${marker}"\nprintf '{"terraform_version":"9.9.9"}\\n'\n`, {
      mode: 0o700,
    });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ binary: "auto", modules: ["module-a"], wrapper }));
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("via wrapper: not probed; wrapper command cannot be represented safely");
      expect(existsSync(marker)).toBe(false);
      expect(output).not.toContain("9.9.9");
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
