import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig, defaults } from "../src/config.js";

describe("config storage", () => {
  it("defaults only when absent and rejects malformed JSON without replacing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfaxi-config-"));
    const path = join(dir, "config.json");
    try {
      expect(readConfig(path)).toEqual(defaults);
      writeFileSync(path, "{not json");
      expect(() => readConfig(path)).toThrow("malformed config");
      expect(readFileSync(path, "utf8")).toBe("{not json");
      writeFileSync(path, '{"modules":null}');
      expect(() => readConfig(path)).toThrow("malformed config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes valid private config atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfaxi-config-"));
    const path = join(dir, "config.json");
    try {
      writeConfig(path, { binary: "tofu", modules: ["module"] });
      expect(readConfig(path)).toEqual({ binary: "tofu", modules: ["module"] });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
