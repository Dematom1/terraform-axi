import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
type StateReport = { resources: { address: string }[]; total: number; attributes: { id: string }; help?: string[] };
type Report = {
  changes: Record<string, string>[];
  risk: { low: number };
  low_risk_omitted?: number;
  help: string[];
  code: string;
  examples: string[];
  defaults: string;
  terraform_axi: { modules: string[]; last_session?: { commands: Record<string, number> } };
};
let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tfaxi-admission-"));
  env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH ?? "" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function cli(args: string[], input?: string, cwd = home, bin = "terraform-axi") {
  const result = spawnSync(process.execPath, [join(root, `dist/bin/${bin}.js`), ...args], {
    env,
    cwd,
    input,
    encoding: "utf8",
  });
  return { ...result, data: decode(result.stdout) as Report };
}
function plan() {
  const path = join(home, "saved plan's.json");
  writeFileSync(
    path,
    JSON.stringify({
      planned_values: {},
      resource_changes: Array.from({ length: 30 }, (_, i) => ({
        address: `terraform_data.item${i}`,
        type: "terraform_data",
        change: { actions: ["create"] },
      })),
    }),
  );
  return path;
}

// Oracles: admission report's six required fixes and AXI principles 2/3/6/7/9/10.
it("1: defaults to four selection fields and exposes extra plan detail explicitly", () => {
  const file = plan();
  expect(Object.keys(cli(["plan", "--plan-json", file]).data.changes[0]!)).toEqual([
    "address",
    "action",
    "type",
    "risk",
  ]);
  expect(cli(["plan", "--plan-json", file, "--fields", "address,flags,reason"]).data.changes[0]).toEqual({
    address: "terraform_data.item0",
    flags: "",
    reason: "",
  });
});
it("2/5: saved-plan truncation carries original counts and a runnable selector-preserving recovery command", () => {
  const file = plan();
  const report = cli(["plan", "--plan-json", file, "--expect", "add=30"]).data;
  expect(report.low_risk_omitted).toBe(5);
  expect(report.risk.low).toBe(30);
  const hint = report.help.find((s: string) => s.includes("--full"));
  expect(hint).toContain("--plan-json");
  expect(hint).toContain("--expect add=30");
  const command = hint!.match(/`([^`]+)`/)![1]!;
  const recovered = spawnSync(
    "/bin/sh",
    ["-c", command.replace(/^terraform-axi/, `${process.execPath} '${join(root, "dist/bin/terraform-axi.js")}'`)],
    { env, encoding: "utf8" },
  );
  expect(recovered.status).toBe(0);
  expect((decode(recovered.stdout) as Report).changes).toHaveLength(30);
});
it("2/5: state --full retrieves every row and complete attributes, with sizes and scoped next commands", () => {
  const fake = join(home, "fake.mjs");
  writeFileSync(
    fake,
    `
    const resources = Array.from({ length: 105 }, (_, i) => ({ address: 'terraform_data.item' + i, type: 'terraform_data', values: { id: 'x'.repeat(500) } }));
    process.stdout.write(process.argv.includes('state') ? resources.map(r => r.address).join('\\n') : JSON.stringify({ values: { root_module: { resources } } }));
  `,
  );
  expect(cli(["setup", "--wrapper", `${process.execPath} ${fake} {module}`]).status).toBe(0);
  const list = cli(["state", "list", "module's path"]).data as unknown as StateReport;
  expect(list.resources).toHaveLength(100);
  expect(list.total).toBe(105);
  expect(list.help?.join(" ")).toContain("--full");
  expect(list.help?.join(" ")).toContain("state resource");
  const all = cli(["state", "list", "module's path", "--full"]).data as unknown as StateReport;
  expect(all.resources).toHaveLength(105);
  const detail = cli(["state", "resource", "module's path", "terraform_data.item0"]).data as unknown as StateReport;
  expect(detail.attributes.id).toContain("500 chars total");
  expect(detail.help?.join(" ")).toContain("--full");
  const full = cli(["state", "resource", "module's path", "terraform_data.item0", "--full"])
    .data as unknown as StateReport;
  expect(full.attributes.id).toHaveLength(500);
  expect(full.help).toBeUndefined();
});
it.each([
  ["doctor", "--bogus", "--offline"],
  ["doctor", "one", "two", "--offline"],
  ["doctor", "--explain"],
  ["setup", "nonsense"],
  ["setup", "hooks", "nonsense"],
  ["setup", "--wrapper", "terraform"],
])("3: usage failures exit 2 without side effects: %j", (...args) => {
  mkdirSync(join(home, "--bogus"), { recursive: true });
  const result = cli(args);
  expect(result.status).toBe(2);
  expect(result.data.code).toBe("VALIDATION_ERROR");
  expect(JSON.stringify(result.data.help)).not.toContain("permissions");
  expect(existsSync(join(home, ".config"))).toBe(false);
});
it.each(["plan", "drift", "lint", "diagnose", "doctor", "setup"])(
  "3/5: %s unknown flags inline valid flags and relevant help",
  (command) => {
    const result = cli([command, "--bogus=do-not-print"]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("do-not-print");
    expect(JSON.stringify(result.data)).toContain("--help");
    expect(result.data.help.join(" ")).toContain(`terraform-axi ${command}`);
    expect(result.data.help.join(" ")).not.toContain("permissions");
  },
);
it.each(["plan", "drift", "lint", "diagnose", "doctor", "state", "setup", "update"])(
  "3: %s accepts help alongside input without invoking dependencies or writing",
  (command) => {
    expect(cli([command, "nonexistent", "--help"]).status).toBe(0);
    expect(existsSync(join(home, ".config"))).toBe(false);
  },
);
it("4: context is directory scoped; explicit end capture enriches only that directory without storing transcript secrets", () => {
  const module = join(home, "module");
  const other = join(home, "other");
  mkdirSync(module);
  mkdirSync(other);
  expect(cli(["setup", "--module", module, "--module", other]).status).toBe(0);
  expect(cli([], "{}", module, "terraform-axi-ctx").data.terraform_axi.modules).toEqual([module]);
  expect(cli([], "{}", home, "terraform-axi-ctx").data.terraform_axi.modules).toEqual([]);
  const transcript = join(home, "transcript.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "terraform-axi plan . --secret=do-not-store" } }],
      },
    }) + "\n",
  );
  expect(
    cli(
      ["--capture"],
      JSON.stringify({ session_id: "ended", cwd: module, transcript_path: transcript }),
      module,
      "terraform-axi-ctx",
    ).status,
  ).toBe(0);
  const next = cli([], JSON.stringify({ session_id: "next" }), module, "terraform-axi-ctx").data.terraform_axi;
  expect(next.last_session?.commands.plan).toBe(1);
  expect(JSON.stringify(next)).not.toContain("do-not-store");
  expect(cli([], "{}", other, "terraform-axi-ctx").data.terraform_axi.last_session).toBeUndefined();
  expect(cli(["setup", "hooks"]).status).toBe(0);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(settings.hooks.SessionEnd).toHaveLength(1);
  const captureFiles = join(home, ".config/terraform-axi/captures");
  for (const file of readdirSync(captureFiles))
    expect(readFileSync(join(captureFiles, file), "utf8")).not.toContain("do-not-store");
});
it("4: relative module registrations stay usable by wrappers while context resolves their registration directory", () => {
  const module = join(home, "module");
  mkdirSync(module);
  const wrapper = join(home, "wrapper.mjs");
  writeFileSync(
    wrapper,
    `if (process.argv[2] !== "module") process.exit(1); process.stdout.write('{"terraform_version":"9.9.9"}');`,
  );
  expect(cli(["setup", "--module", "module", "--wrapper", `${process.execPath} ${wrapper} {module}`]).status).toBe(0);
  const config = JSON.parse(readFileSync(join(home, ".config/terraform-axi/config.json"), "utf8"));
  expect(config.modules).toEqual(["module"]);
  expect(cli([], "{}", module, "terraform-axi-ctx").data.terraform_axi.modules).toEqual(["module"]);
  expect(cli([], "{}", home, "terraform-axi-ctx").data.terraform_axi.modules).toEqual([]);
  expect(cli([]).stdout).toContain("9.9.9");
});
it("3/6: built-in update rejects bad input with usage status and inlines all supported flags", () => {
  const result = cli(["update", "--bogus"]);
  expect(result.status).toBe(2);
  expect(result.data.code).toBe("VALIDATION_ERROR");
  expect(result.data.help.join(" ")).toContain("--check");
  expect(result.data.help.join(" ")).toContain("--dry-run");
  expect(existsSync(join(home, ".config"))).toBe(false);
});
it.each(["plan", "drift", "lint", "diagnose", "doctor", "state", "setup", "update"])(
  "6: %s help has defaults and at least two examples",
  (command) => {
    const report = cli([command, "--help"]).data;
    expect(report.examples.length).toBeGreaterThanOrEqual(2);
    expect(report.defaults).toBeDefined();
  },
);
it("6: bare versions work without a command graph and stay near the same-run Node startup floor", () => {
  const install = join(home, "install");
  mkdirSync(join(install, "dist/src"), { recursive: true });
  mkdirSync(join(install, "dist/bin"), { recursive: true });
  cpSync(join(root, "dist/bin/terraform-axi.js"), join(install, "dist/bin/terraform-axi.js"));
  cpSync(join(root, "dist/src/version.js"), join(install, "dist/src/version.js"));
  symlinkSync(join(root, "node_modules"), join(install, "node_modules"), "dir");
  writeFileSync(join(install, "package.json"), '{"type":"module"}');
  const entry = join(install, "dist/bin/terraform-axi.js");
  const packageVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const floor: number[] = [];
  const version: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (const [args, samples, expected] of [
      [["-e", 'console.log("floor")'], floor, "floor\n"],
      [[entry, ["-v", "-V", "--version"][i % 3]!], version, `${packageVersion}\n`],
    ] as const) {
      const start = performance.now();
      const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
      samples.push(performance.now() - start);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
  }
  // Five interleaved cold processes with scheduler slack; missing-graph isolation is the deterministic guard.
  expect(version.sort((a, b) => a - b)[2]!).toBeLessThan(floor.sort((a, b) => a - b)[2]! * 4 + 100);
  expect(spawnSync(process.execPath, [entry, "plan", "--help"], { env }).status).not.toBe(0);
});
