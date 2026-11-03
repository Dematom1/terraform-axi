import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function isReleaseBotOnly(commits, { botLogin, repository, headRepository, headRef }) {
  return (
    Boolean(botLogin) &&
    repository === headRepository &&
    headRef.startsWith("release-please--") &&
    commits.length > 0 &&
    commits.every(
      ([author, committer, verified]) =>
        author === botLogin && (committer === botLogin || committer === "web-flow") && verified === "true",
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commits = readFileSync(0, "utf8")
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  process.stdout.write(
    String(
      isReleaseBotOnly(commits, {
        botLogin: process.env.RELEASE_APP_BOT_LOGIN,
        repository: process.env.REPOSITORY,
        headRepository: process.env.HEAD_REPOSITORY,
        headRef: process.env.HEAD_REF ?? "",
      }),
    ),
  );
}
