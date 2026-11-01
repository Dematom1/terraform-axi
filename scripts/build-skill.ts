import { readFileSync, writeFileSync } from "node:fs";
const path = "skills/terraform-axi/SKILL.md";
const source = readFileSync("README.md", "utf8");
const commands = source
  .slice(source.indexOf("## Commands"))
  .replaceAll("](VISION.md)", "](../../VISION.md)")
  .replaceAll("](CONTRIBUTING.md)", "](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md)");
const body = `---\nname: terraform-axi\ndescription: Read-only Terraform and OpenTofu CLI; plan risk summaries and --expect count assertions. Drift, doctor, and state commands are planned.\n---\n\n# terraform-axi\n\nUse terraform-axi for read-only infrastructure inspection. Never apply or destroy.\n\nSee the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for the full command list.\n\n${commands}`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== body) throw new Error(`${path} is stale; run npm run build:skill`);
} else writeFileSync(path, body);
