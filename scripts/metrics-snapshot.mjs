// Daily adoption snapshot from owner-aggregate APIs only: GitHub traffic, public npm download counts, and
// release freshness (latest GitHub release vs npm dist-tags.latest).
// Nothing here runs inside the CLI; terraform-axi itself sends no telemetry.
// Usage: node scripts/metrics-snapshot.mjs > snapshot.json
//        node scripts/metrics-snapshot.mjs --check-releases snapshot.json   (exits 1 on a mismatch older than 24h)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";

export const REPOS = [
  "terraform-axi",
  "argocd-axi",
  "datadog-axi",
  "argo-workflows-axi",
  "search-console-axi",
  "k8s-axi",
];
const OWNER = "Dematom1";
const TRAFFIC = {
  views: "traffic/views?per=day",
  clones: "traffic/clones?per=day",
  referrers: "traffic/popular/referrers",
  paths: "traffic/popular/paths",
};
const GRACE_HOURS = 24;

const getJSON = async (fetchImpl, url, headers = {}) => {
  const response = await fetchImpl(url, { headers: { "user-agent": "dematom1-axi-metrics", ...headers } });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).pathname}`);
  return response.json();
};

/** A mismatch starts when the newer of the two sides was published, so no state is needed between runs. */
export function releaseFreshness(release, registry, now, repo) {
  const tag = release.tag_name;
  const npmVersion = registry["dist-tags"]?.latest;
  const npmPublishedAt = registry.time?.[npmVersion];
  const githubPublishedAt = Date.parse(release.published_at);
  const npmPublishedTime = Date.parse(npmPublishedAt);
  if (typeof tag !== "string" || !tag || !Number.isFinite(githubPublishedAt) ||
      typeof npmVersion !== "string" || !npmVersion || !Number.isFinite(npmPublishedTime)) {
    throw new Error("Invalid release freshness metadata");
  }
  const versionPattern = new RegExp(`^(?:${repo}-)?v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$`);
  const githubVersion = tag.match(versionPattern)?.[1] ?? null;
  const since = Math.max(githubPublishedAt, npmPublishedTime);
  const inSync = githubVersion !== null && githubVersion === npmVersion;
  return {
    github_tag: tag,
    github_version: githubVersion,
    github_published_at: release.published_at,
    npm_latest: npmVersion,
    npm_published_at: npmPublishedAt,
    in_sync: inSync,
    mismatch_hours: inSync ? 0 : Math.floor((now.getTime() - since) / 3_600_000),
  };
}

/** Builds one dated snapshot. Without a traffic token, GitHub traffic is recorded as skipped and the rest still runs. */
export async function snapshot({ token, releaseToken = token, fetchImpl = globalThis.fetch, now = new Date() }) {
  const auth = (value) => (value ? { authorization: `Bearer ${value}`, accept: "application/vnd.github+json" } : {});
  const repos = {};
  for (const repo of REPOS) {
    const github = {};
    for (const [key, path] of Object.entries(TRAFFIC)) {
      github[key] = token
        ? await getJSON(fetchImpl, `https://api.github.com/repos/${OWNER}/${repo}/${path}`, auth(token))
        : "skipped: METRICS_TRAFFIC_TOKEN not set";
    }
    const npm = {
      downloads: await getJSON(fetchImpl, `https://api.npmjs.org/downloads/range/last-month/${repo}`),
      versions: await getJSON(fetchImpl, `https://api.npmjs.org/versions/${repo}/last-week`),
    };
    const release = releaseFreshness(
      await getJSON(fetchImpl, `https://api.github.com/repos/${OWNER}/${repo}/releases/latest`, auth(releaseToken)),
      await getJSON(fetchImpl, `https://registry.npmjs.org/${repo}`),
      now,
      repo,
    );
    repos[repo] = { github, npm, release };
  }
  return { date: now.toISOString().slice(0, 10), captured_at: now.toISOString(), repos };
}

/** Lists repos whose latest GitHub release and npm latest have disagreed for more than 24 hours. */
export function staleReleases(result) {
  return Object.entries(result.repos)
    .filter(([, { release }]) => !release.in_sync && release.mismatch_hours > GRACE_HOURS)
    .map(
      ([repo, { release }]) =>
        `${repo}: GitHub release ${release.github_version} vs npm latest ${release.npm_latest} for ${release.mismatch_hours}h`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkIndex = process.argv.indexOf("--check-releases");
  if (checkIndex === -1) {
    const result = await snapshot({
      token: process.env.METRICS_TRAFFIC_TOKEN || undefined,
      releaseToken: process.env.GH_TOKEN || process.env.METRICS_TRAFFIC_TOKEN || undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const stale = staleReleases(JSON.parse(readFileSync(process.argv[checkIndex + 1], "utf8")));
    for (const line of stale) process.stderr.write(`::error::${line}\n`);
    process.exitCode = stale.length > 0 ? 1 : 0;
  }
}
