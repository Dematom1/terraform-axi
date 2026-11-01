import { describe, expect, it } from "vitest";
import { parseState } from "../src/state/model.js";
import { redactState } from "../src/state/redact.js";

const fixture = {
  format_version: "1.0",
  values: {
    root_module: {
      resources: [
        {
          address: "terraform_data.secret",
          type: "terraform_data",
          mode: "managed",
          provider_name: "terraform.io/builtin/terraform",
          instances: [
            {
              attributes: {
                id: "id-1",
                input: "hunter2",
                password_note: "also secret",
                nested: [{ token_value: "list-secret" }],
              },
              sensitive_values: { input: true, nested: [{ token_value: true }] },
            },
          ],
        },
        {
          address: "aws_secretsmanager_secret.item",
          type: "aws_secretsmanager_secret",
          mode: "managed",
          provider_name: "registry.terraform.io/hashicorp/aws",
          instances: [
            {
              attributes: { id: "id-2", name: "safe-name", arn: "safe-arn", payload: { value: "secret-value" } },
              sensitive_values: {},
            },
          ],
        },
      ],
      child_modules: [
        {
          address: "module.child",
          resources: [
            {
              address: "module.child.terraform_data.nested",
              type: "terraform_data",
              mode: "managed",
              provider_name: "terraform.io/builtin/terraform",
              instances: [{ attributes: { input: "child-secret" }, sensitive_values: { input: true } }],
            },
          ],
        },
      ],
    },
  },
  outputs: { pw: { sensitive: true, value: "hunter2" }, public: { sensitive: false, value: "visible" } },
};

describe("state model and redaction", () => {
  it("walks modules and removes marked, named, and secret-resource values", () => {
    const state = parseState(JSON.stringify(fixture));
    expect(state.resources.map(({ address }) => address)).toEqual([
      "terraform_data.secret",
      "aws_secretsmanager_secret.item",
      "module.child.terraform_data.nested",
    ]);
    expect(state.resources[2]?.module).toBe("module.child");
    const redacted = redactState(state);
    const serialized = JSON.stringify(redacted);
    for (const secret of ["hunter2", "also secret", "list-secret", "secret-value", "child-secret"])
      expect(serialized).not.toContain(secret);
    expect(redacted.outputs).toEqual([
      { name: "pw", sensitive: true },
      { name: "public", sensitive: false },
    ]);
    expect(redacted.resources[1]?.attributes).toEqual({
      id: "id-2",
      name: "safe-name",
      arn: "safe-arn",
      payload: "[redacted]",
    });
    expect(redacted.redacted).toBeGreaterThanOrEqual(5);
  });

  it("rejects malformed JSON without echoing its contents", () => {
    const input = '{"password":"do-not-echo"';
    try {
      parseState(input);
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("do-not-echo");
    }
  });
});
