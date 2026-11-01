import { readFileSync } from "node:fs";

export function isReleaseBotOnly(authors) {
  return authors.length > 0 && authors.every((author) => author === "release-please[bot]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const authors = input ? input.split(/\r?\n/) : [];
  process.stdout.write(String(isReleaseBotOnly(authors)));
}
