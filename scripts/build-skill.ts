import { readFileSync, writeFileSync } from "node:fs";
const path = "skills/terraform-axi/SKILL.md";
const source = readFileSync("README.md", "utf8");
const body = `---\nname: terraform-axi\ndescription: Read-only Terraform and OpenTofu plan and state inspection CLI.\n---\n\n# terraform-axi\n\nUse terraform-axi for read-only infrastructure inspection. Never apply or destroy.\n\n${source.split("## Commands")[0]}`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== body) throw new Error(`${path} is stale; run npm run build:skill`);
} else writeFileSync(path, body);
