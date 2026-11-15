// Measures the tokens an agent reads from raw Terraform output vs terraform-axi on the demo fixture.
// Usage: npm run build && node demo/benchmark.mjs   (needs terraform on PATH; downloads hashicorp/local once)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { buildFixture } from "./fixture.mjs";

const cli = join(import.meta.dirname, "..", "dist", "bin", "terraform-axi.js");
const home = mkdtempSync(join(tmpdir(), "tfaxi-bench-"));
const module = join(home, "infra");
// Only PATH reaches the subprocesses: no cloud credentials and no TF_* variables.
const env = { PATH: process.env.PATH ?? "", HOME: home, CHECKPOINT_DISABLE: "1" };

/** Returns stdout, which is what an agent reads; exit 2 means changes are present. */
const run = (command, args, acceptedStatuses = [0]) => {
  const result = spawnSync(command, args, { cwd: home, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!acceptedStatuses.includes(result.status)) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const terraform = (...args) => run("terraform", ["-chdir=infra", "plan", "-input=false", "-lock=false", ...args], [0, 2]);
const axi = (...args) => run(process.execPath, [cli, ...args, "infra", "--binary", "terraform"]);

const print = (line) => process.stdout.write(`${line}\n`);

try {
  const terraformVersion = JSON.parse(run("terraform", ["version", "-json"])).terraform_version;
  if (terraformVersion !== "1.15.8") throw new Error(`benchmark requires Terraform 1.15.8, found ${terraformVersion}`);
  buildFixture(module);
  const rows = [
    ["Review a plan", "`terraform plan -json`", terraform("-json"), "`terraform-axi plan`", axi("plan")],
    ["Review a plan", "`terraform plan` (text)", terraform("-no-color"), "`terraform-axi plan`", axi("plan")],
    [
      "Check drift",
      "`terraform plan -refresh-only -json`",
      terraform("-refresh-only", "-json"),
      "`terraform-axi drift`",
      axi("drift"),
    ],
  ];
  const localVersion = readFileSync(join(module, ".terraform.lock.hcl"), "utf8").match(/provider "registry\.terraform\.io\/hashicorp\/local" \{[\s\S]*?version\s*=\s*"([^"]+)"/)?.[1];
  if (!localVersion) throw new Error("hashicorp/local version missing from Terraform lock file");
  print(`terraform ${terraformVersion}, hashicorp/local ${localVersion}, o200k_base tokenizer\n`);
  print("| Task | Raw command | Tokens | terraform-axi | Tokens | Saved |");
  print("| --- | --- | ---: | --- | ---: | ---: |");
  for (const [task, rawName, raw, axiName, out] of rows) {
    const [a, b] = [countTokens(raw), countTokens(out)];
    print(
      `| ${task} | ${rawName} | ${a.toLocaleString("en-US")} | ${axiName} | ${b.toLocaleString("en-US")} | ${Math.round((1 - b / a) * 100)}% |`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
