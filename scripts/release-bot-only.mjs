import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isReleaseBotOnly(authors) {
  return authors.length > 0 && authors.every((author) => author === "release-please[bot]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const authors = input ? input.split(/\r?\n/) : [];
  process.stdout.write(String(isReleaseBotOnly(authors)));
}
