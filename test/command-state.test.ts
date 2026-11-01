import { decode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";
import { stateCommand } from "../src/commands/state.js";

const runOperation = vi.hoisted(() => vi.fn());
vi.mock("../src/runner.js", () => ({ runOperation }));
const config = { binary: "auto" as const, modules: [] };
const state = (resources: unknown[]) => JSON.stringify({ values: { root_module: { resources } } });
const terraformData = (address: string, input: string) => ({
  address,
  type: "terraform_data",
  instances: [{ attributes: { input, output: input }, sensitive_values: { input: true, output: true } }],
});
const result = (stdout: string) => ({ stdout, stderr: "" });
const invoke = async (...args: string[]) =>
  decode(await stateCommand(config, args), { strict: true }) as Record<string, unknown>;

describe("state command", () => {
  it("redacts resource values, respects full, and reports nearest addresses", async () => {
    runOperation.mockResolvedValue(result(state([terraformData("terraform_data.secret", "hunter2")])));
    const ordinary = JSON.stringify(await invoke("resource", "mod", "terraform_data.secret"));
    expect(ordinary).not.toContain("hunter2");
    expect(ordinary).toContain("[redacted]");
    const full = JSON.stringify(await invoke("resource", "mod", "terraform_data.secret", "--full"));
    expect(full).not.toContain("hunter2");
    expect(full).toContain("[redacted]");
    runOperation.mockResolvedValue(result(state([terraformData("terraform_data.secret", "safe")])));
    expect(JSON.stringify(await invoke("resource", "mod", "terraform_data.secre", "--full"))).toContain(
      "terraform_data.secret",
    );
  });

  it("cuts attributes at 200 characters unless full is set", async () => {
    const longValue = "x".repeat(250);
    runOperation.mockResolvedValue(
      result(
        state([
          {
            address: "test_resource.example",
            type: "test_resource",
            instances: [{ attributes: { label: longValue }, sensitive_values: {} }],
          },
        ]),
      ),
    );
    const ordinary = JSON.stringify(await invoke("resource", "mod", "test_resource.example"));
    expect(ordinary).toContain("x".repeat(200));
    expect(ordinary).not.toContain("x".repeat(201));
    const full = JSON.stringify(await invoke("resource", "mod", "test_resource.example", "--full"));
    expect(full).toContain(longValue);
  });

  it("bounds lists, retains total, enriches full types, and reports empty state", async () => {
    const addresses = Array.from({ length: 105 }, (_, i) => `terraform_data.item${i}`).join("\n");
    runOperation.mockResolvedValue(result(`${addresses}\n`));
    const output = await invoke("list", "mod");
    expect(output.total).toBe(105);
    expect(output.resources as unknown[]).toHaveLength(100);
    expect(runOperation).toHaveBeenLastCalledWith(config, "mod", "state_list");
    runOperation
      .mockResolvedValueOnce(result("terraform_data.secret\n"))
      .mockResolvedValueOnce(result(state([terraformData("terraform_data.secret", "hunter2")])));
    expect(JSON.stringify(await invoke("list", "mod", "--full"))).toContain("terraform_data");
    runOperation.mockResolvedValue(result(""));
    expect(await invoke("list", "mod")).toMatchObject({ status: "empty_state", total: 0 });
  });

  it("does not echo malformed state JSON", async () => {
    runOperation.mockResolvedValue(result('{"secret":"hunter2"'));
    await expect(stateCommand(config, ["resource", "mod", "terraform_data.secret"])).rejects.toThrow(
      /bytes \(SyntaxError\)/,
    );
    await expect(stateCommand(config, ["resource", "mod", "terraform_data.secret"])).rejects.not.toThrow("hunter2");
  });
});
