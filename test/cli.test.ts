import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("terraform-axi scaffold", () => {
  it("keeps all operational commands read-only stubs", async () => {
    const chunks: string[] = [];
    await main(["plan", "module"], { write: (chunk: string) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("not implemented in scaffold");
    expect(chunks.join("")).not.toMatch(/apply|destroy/i);
  });
});
