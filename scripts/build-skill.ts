import { readFileSync, writeFileSync } from "node:fs";
const path = "skills/terraform-axi/SKILL.md";
const source = readFileSync("README.md", "utf8");
const commands = source
  .slice(source.indexOf("## Commands"))
  .replaceAll("](VISION.md)", "](../../VISION.md)")
  .replaceAll("](CONTRIBUTING.md)", "](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md)");
const body = `---\nname: terraform-axi\ndescription: Read-only Terraform/OpenTofu plan, drift and state for agents. Summarizes risky changes, reports drift without attribute values, and redacts secrets; never applies, destroys or writes state.\n---\n\n# terraform-axi\n\nUse terraform-axi for read-only infrastructure inspection. Never apply or destroy.\n\nYou do not need terraform-axi installed globally - run every command as \`npx -y terraform-axi <command>\`. If terraform-axi output suggests a command starting with \`terraform-axi\`, run it as \`npx -y terraform-axi ...\` instead. Use bare \`terraform-axi\` only when it is installed globally.\n\nSee the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for the full command list.\n\n${commands}`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== body) throw new Error(`${path} is stale; run npm run build:skill`);
} else writeFileSync(path, body);
