import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isReleaseBotOnly(commits) {
  return commits.length > 0 && commits.every(
    (commit) =>
      commit.length === 2 &&
      commit[0] === "release-please[bot]" &&
      commit[1] === "release-please[bot]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commits = readFileSync(0, "utf8")
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  process.stdout.write(String(isReleaseBotOnly(commits)));
}
