import { describe, expect, it } from "vitest";
import { REPOS, releaseFreshness, snapshot, staleReleases } from "../scripts/metrics-snapshot.mjs";

const now = new Date("2026-11-15T06:17:00Z");
const release = (tag, published_at = "2026-11-11T00:00:00Z") => ({ tag_name: tag, published_at });
const registry = (latest, at = "2026-11-11T01:00:00Z") => ({ "dist-tags": { latest }, time: { [latest]: at } });

const releaseTags = Object.fromEntries(REPOS.map((repo) => [repo, `${repo}-v0.1.0`]));
const fakeFetch = (calls) => async (url, init) => {
  calls.push({ url, authorization: init.headers.authorization });
  const repo = new URL(url).pathname.split("/")[3];
  const body = url.endsWith("/releases/latest")
    ? release(releaseTags[repo])
    : url.startsWith("https://registry.npmjs.org/")
      ? registry("0.1.0")
      : { url };
  return { ok: true, json: async () => body };
};

describe("metrics snapshot", () => {
  it("records npm stats and releases but skips GitHub traffic without a token", async () => {
    const calls = [];
    const result = await snapshot({ fetchImpl: fakeFetch(calls), now });
    expect(result.date).toBe("2026-11-15");
    expect(Object.keys(result.repos)).toEqual(REPOS);
    expect(result.repos["k8s-axi"].github.views).toMatch(/^skipped/);
    expect(result.repos["k8s-axi"].release).toMatchObject({
      github_version: "0.1.0",
      npm_latest: "0.1.0",
      in_sync: true,
    });
    expect(calls.some(({ url }) => url.includes("/traffic/"))).toBe(false);
    expect(calls.every(({ authorization }) => authorization === undefined)).toBe(true);
  });

  it("sends the traffic token to GitHub only", async () => {
    const calls = [];
    const result = await snapshot({ token: "tok", fetchImpl: fakeFetch(calls), now });
    expect(result.repos["terraform-axi"].github.referrers).toEqual({
      url: "https://api.github.com/repos/Dematom1/terraform-axi/traffic/popular/referrers",
    });
    for (const { url, authorization } of calls) {
      expect(authorization).toBe(url.startsWith("https://api.github.com/") ? "Bearer tok" : undefined);
    }
    expect(calls).toHaveLength(REPOS.length * 8);
  });

  it("fails on an API error instead of writing a partial snapshot", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await expect(snapshot({ token: "tok", fetchImpl, now })).rejects.toThrow("403 from /repos/Dematom1/terraform-axi");
  });
});

describe("release freshness", () => {
  const repos = (entry) => ({ repos: { "terraform-axi": { release: entry } } });

  it("flags a GitHub release that npm latest has lacked for more than 24h", () => {
    const entry = releaseFreshness(release("terraform-axi-v0.1.7", "2026-11-14T06:00:00Z"), registry("0.1.6"), now);
    expect(entry).toMatchObject({ in_sync: false, mismatch_hours: 24 });
    expect(staleReleases(repos(entry))).toEqual([]);
    const later = releaseFreshness(
      release("terraform-axi-v0.1.7", "2026-11-14T06:00:00Z"),
      registry("0.1.6"),
      new Date("2026-11-15T07:00:00Z"),
    );
    expect(staleReleases(repos(later))).toEqual(["terraform-axi: GitHub release 0.1.7 vs npm latest 0.1.6 for 25h"]);
  });

  it("rejects missing or unparsable release metadata", () => {
    for (const [badRelease, badRegistry] of [
      [release(null), registry("0.1.0")],
      [release("v0.1.0", "not-a-date"), registry("0.1.0")],
      [release("v0.1.0"), registry(null)],
      [release("v0.1.0"), { "dist-tags": { latest: "0.1.0" }, time: { "0.1.0": "not-a-date" } }],
    ]) {
      expect(() => releaseFreshness(badRelease, badRegistry, now)).toThrow("Invalid release freshness metadata");
    }
  });

  it("keeps unrecognized release tags out of sync", () => {
    expect(releaseFreshness(release("unrecognized"), registry("0.1.0"), now)).toMatchObject({
      github_version: "unrecognized",
      in_sync: false,
    });
  });

  it("measures a mismatch from the newer side and accepts matching versions", () => {
    expect(
      releaseFreshness(release("v0.1.6", "2026-11-01T00:00:00Z"), registry("0.1.7", "2026-11-15T00:00:00Z"), now)
        .mismatch_hours,
    ).toBe(6);
    expect(releaseFreshness(release("v0.1.6"), registry("0.1.6"), now)).toMatchObject({
      in_sync: true,
      mismatch_hours: 0,
    });
  });
});
