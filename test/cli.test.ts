
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("terraform-axi plan", () => {
  it("reports that plan is not implemented in the scaffold", async () => {
    const chunks: string[] = [];
    await main(["plan"], { write: (chunk: string) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("not implemented in scaffold");
  });
});
