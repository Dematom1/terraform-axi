import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function realModule(files: Record<string, string>, binary = "terraform"): string {
  const directory = mkdtempSync(join(tmpdir(), "tfaxi-module-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, { mode: 0o600 });
  }
  if (!Object.keys(files).some((name) => name.endsWith(".tf"))) {
    writeFileSync(
      join(directory, "main.tf"),
      'terraform {\n  backend "local" {}\n}\nresource "terraform_data" "test" {}\n',
      { mode: 0o600 },
    );
  }
  execFileSync(binary, ["-chdir=" + directory, "init", "-input=false", "-lockfile=readonly"], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, ".config"),
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
    },
  });
  return directory;
}
