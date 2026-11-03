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
    "%s gates its release check on verified release-bot commits",
    (workflowName) => {
      const workflowPath = `.github/workflows/${workflowName}.yml`;
      const parseWorkflow = `
        const fs = require("node:fs");
        const yaml = require("js-yaml");
        const workflow = yaml.load(fs.readFileSync(process.argv[1], "utf8"));
        const steps = workflow.jobs.check.steps;
        const release = steps.find((step) => step.id === "release");
        const gate = steps.find((step) => step.if?.includes("steps.release.outputs.bot_only != 'true'"));
        process.stdout.write(JSON.stringify({
          releaseEnvironment: release.env,
          gateIf: gate.if,
          trustedCheckout: steps.some((step) => step.with?.path === "trusted"),
        }));
      `;
      const contract: {
        releaseEnvironment: Record<string, string>;
        gateIf: string;
        trustedCheckout: boolean;
      } = JSON.parse(
        execFileSync(process.execPath, ["-e", parseWorkflow, workflowPath], { cwd: root, encoding: "utf8" }),
      );
      expect(contract.gateIf).toBe(
        workflowName === "no-mistakes-required"
          ? "github.event.pull_request.user.login != 'renovate[bot]' && steps.release.outputs.bot_only != 'true'"
          : "steps.release.outputs.bot_only != 'true'",
      );
      expect(contract.trustedCheckout).toBe(true);
      expect(contract.releaseEnvironment).toMatchObject({
        REPOSITORY: "${{ github.repository }}",
        HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
        HEAD_REF: "${{ github.event.pull_request.head.ref }}",
        RELEASE_APP_BOT_LOGIN: "${{ vars.RELEASE_APP_BOT_LOGIN }}",
      });

      const helper = join(root, "scripts/release-bot-only.mjs");
      const isBotOnly = (commits: string, overrides: Record<string, string> = {}) =>
        execFileSync(process.execPath, [helper], {
          input: commits,
          encoding: "utf8",
          env: {
            ...process.env,
            RELEASE_APP_BOT_LOGIN: "app[bot]",
            REPOSITORY: "example/project",
            HEAD_REPOSITORY: "example/project",
            HEAD_REF: "release-please--branches--main",
            ...overrides,
          },
        }) === "true";
      expect(isBotOnly("app[bot]\tapp[bot]\ttrue\n")).toBe(true);
      // GitHub's signed release-please commits use web-flow as committer.
      expect(isBotOnly("app[bot]\tweb-flow\ttrue\n")).toBe(true);
      expect(isBotOnly("app[bot]\tweb-flow\tfalse\n")).toBe(false);
      expect(isBotOnly("human\tweb-flow\ttrue\n")).toBe(false);
      expect(isBotOnly("app[bot]\thuman\ttrue\n")).toBe(false);
      expect(isBotOnly("app[bot]\tweb-flow\ttrue\nhuman\tweb-flow\ttrue\n")).toBe(false);
      expect(isBotOnly("app[bot]\tweb-flow\ttrue\n", { HEAD_REF: "feature" })).toBe(false);
      expect(isBotOnly("")).toBe(false);
      expect(isBotOnly("human\tapp[bot]\ttrue\n")).toBe(false);
      expect(isBotOnly("app[bot]\tapp[bot]\tfalse\n")).toBe(false);
      expect(isBotOnly("app[bot]\tapp[bot]\ttrue\n", { HEAD_REPOSITORY: "fork/project" })).toBe(false);
      expect(isBotOnly("app[bot]\tapp[bot]\ttrue\n", { RELEASE_APP_BOT_LOGIN: "" })).toBe(false);
    },
  );

  it("excludes generated changelogs from formatting without exempting authored Markdown", () => {
    const directory = mkdtempSync(join(tmpdir(), "terraform-axi-format-"));
    const prettier = join(root, "node_modules/prettier/bin/prettier.cjs");
    const ignore = join(directory, ".prettierignore");
    writeFileSync(ignore, readFileSync(join(root, ".prettierignore")));
    const check = (name: string) => {
      const path = join(directory, name);
      writeFileSync(path, "# Heading\n\n\n*   generated entry\n");
      return spawnSync(process.execPath, [prettier, "--check", "--ignore-path", ignore, path], {
        cwd: directory,
        encoding: "utf8",
      });
    };
    try {
      const changelog = check("CHANGELOG.md");
      expect(changelog.status, changelog.stderr).toBe(0);
      expect(check("README.md").status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("shows the implemented state commands in help", () => {
    const result = spawnSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js"), "state", "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("state list <module> [--full] | state resource <module> <address> [--full]");
    expect(result.stdout).not.toContain("NOT_IMPLEMENTED");
  });

  it.each([
    ["HTTP 403 download_cap_exceeded secret=do-not-print", "daily cap"],
    ["InvalidAccessKeyId key=do-not-print", "key ID"],
  ])("explains captured diagnostics without echoing secrets", (diagnostic, expected) => {
    const result = spawnSync(
      process.execPath,
      [join(root, "dist", "bin", "terraform-axi.js"), "doctor", "--explain", "-"],
      {
        input: diagnostic,
        encoding: "utf8",
        env: { ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stdout).not.toContain("do-not-print");
  });

  it("returns an explicit unmatched result for unknown diagnostics", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "dist", "bin", "terraform-axi.js"), "doctor", "--explain", "unrelated error"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matched: false");
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
      expect(output).not.toMatch(/^\s+(terraform|tofu):/m);
      expect(output).not.toContain("9.9.9");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["terraform_version", "terraform"],
    ["tofu_version", "opentofu"],
  ])("identifies %s from a configured wrapper response", (field, flavor) => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const wrapper = join(home, "wrapper-executable");
    writeFileSync(wrapper, `#!/bin/sh\nprintf '{"${field}":"9.9.9"}\\n'\n`, { mode: 0o700 });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ binary: "auto", modules: ["module-a"], wrapper: `${wrapper} {module}` }),
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain(`wrapper: wrapper-selected/${flavor} 9.9.9`);
      expect(output).not.toMatch(/^\s+(terraform|tofu):/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows why auto mode falls back to OpenTofu", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    writeFileSync(
      join(home, "terraform"),
      `#!/bin/sh
exit 1
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(home, "tofu"),
      `#!/bin/sh
printf '{"tofu_version":"1.2.3"}\\n'
`,
      { mode: 0o700 },
    );
    try {
      const output = execFileSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: home, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(output).toContain("1.2.3 (Terraform probe failed: failed)");
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

  it("rejects unexpected setup arguments without changing config", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, "config.json");
    const original = JSON.stringify({ binary: "auto", modules: ["module-a"] });
    writeFileSync(path, original);
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, "dist", "bin", "terraform-axi.js"), "setup", "--binary", "tofu", "typo"],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["status", "typo"],
    ["hooks", "--bogus"],
    ["uninstall", "typo"],
  ])("rejects extra setup arguments for %s before handling it", (action, extra) => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, "dist", "bin", "terraform-axi.js"), "setup", action, extra],
        { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(existsSync(join(home, ".config", "terraform-axi", "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports an invalid saved modules value as malformed config", () => {
    const home = mkdtempSync(join(tmpdir(), "terraform-axi-test-"));
    const configDir = join(home, ".config", "terraform-axi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"modules":null}');
    try {
      const result = spawnSync(process.execPath, [join(root, "dist", "bin", "terraform-axi.js")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("malformed config");
      const setup = spawnSync(
        process.execPath,
        [join(root, "dist", "bin", "terraform-axi.js"), "setup", "--binary", "tofu"],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        },
      );
      expect(setup.status).toBe(1);
      expect(readFileSync(join(configDir, "config.json"), "utf8")).toBe('{"modules":null}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
