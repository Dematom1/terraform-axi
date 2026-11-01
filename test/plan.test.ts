import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePlanEvents } from "../src/plan/events.js";
import { classifyRisks } from "../src/plan/risk.js";
import { evaluateExpect, parseExpect } from "../src/plan/expect.js";

const fixture = readFileSync(new URL("./fixtures/plan/terraform-1.15.8.jsonl", import.meta.url), "utf8");

describe("plan events, risk, and expectations", () => {
  it("parses captured Terraform 1.15.8 stream", () => {
    const events = parsePlanEvents(fixture);
    expect(events.flavor).toBe("terraform");
    expect(events.version).toBe("1.15.8");
    expect(events.changes[0]).toMatchObject({
      address: "terraform_data.sample",
      action: "create",
      type: "terraform_data",
    });
    expect(events.summary).toMatchObject({ add: 1, change: 0, destroy: 0 });
  });
  it("keeps no-op changes out of change and risk classification", () => {
    const events = parsePlanEvents('{"type":"planned_change","change":{"resource":{"addr":"x","resource_type":"terraform_data"},"actions":["no-op"]}}');
    expect(events.changes).toHaveLength(0);
    const output = parsePlanEvents('{"type":"outputs","outputs":{"token":{"sensitive":true,"change":{"actions":["no-op"]}}}}');
    expect(classifyRisks(output)).toHaveLength(0);
  });
  it("retains provider-specific actions in changes and drift", () => {
    const events = parsePlanEvents(
      '{"type":"planned_change","change":{"resource":{"addr":"x"},"actions":["provider-action"]}}\n{"type":"resource_drift","change":{"resource":{"addr":"y"},"actions":["provider-drift"]}}',
    );
    expect(events.changes[0]?.action).toBe("provider-action");
    expect(events.drift[0]?.action).toBe("provider-drift");
  });
  it("treats incomplete summaries as unavailable", () => {
    const events = parsePlanEvents('{"type":"change_summary","changes":{"import":1}}');
    expect(events.summary).toBe("unavailable");
    expect(evaluateExpect(parseExpect("add=0"), events).status).toBe("fail");
  });
  it("rejects malformed lines without retaining their contents and treats absent summaries as unavailable", () => {
    const events = parsePlanEvents('{garbage secret}\n{"type":"diagnostic","message":"bad"}');
    expect(events.malformed).toBe(1);
    expect(JSON.stringify(events)).not.toContain("garbage secret");
    expect(events.summary).toBe("unavailable");
    expect(events.diagnostics).toHaveLength(1);
  });
  it.each(["", "add=-1", "add=1.2", "add=1,add=2", "unknown=2", "add=1,", "add=9007199254740993"])(
    "rejects invalid expectation %s",
    (value) => {
      expect(() => parseExpect(value)).toThrow();
    },
  );
  it("evaluates full and partial expectations and reports addresses", () => {
    const events = parsePlanEvents(fixture);
    expect(evaluateExpect(parseExpect("add=1,destroy=0"), events).status).toBe("pass");
    const failed = evaluateExpect(parseExpect("destroy=1"), events);
    expect(failed.status).toBe("fail");
    expect(failed.reasons[0]).toContain("expected 1, planned 0");
  });
  it.each(["google_iam", "github_permission"])(
    "does not overmatch IAM type %s",
    (type) => {
      const events = parsePlanEvents(
        `{"type":"planned_change","change":{"resource":{"addr":"x","resource_type":"${type}"},"action":"create"}}`,
      );
      expect(classifyRisks(events)[0]?.flags).not.toContain("iam");
    },
  );
  it("does not classify non-secret GitHub Actions resources as secrets", () => {
    const events = parsePlanEvents(
      '{"type":"planned_change","change":{"resource":{"addr":"x","resource_type":"github_actions_workflow"},"action":"create"}}',
    );
    expect(classifyRisks(events)[0]?.flags).not.toContain("secret");
  });
  it.each([
    "aws_iam_role",
    "google_project_iam_policy",
    "azurerm_role_assignment",
    "kubernetes_role",
    "github_repository_permission",
  ])("marks IAM type %s high risk", (type) => {
    const events = parsePlanEvents(
      `{"type":"planned_change","change":{"resource":{"addr":"x","resource_type":"${type}"},"action":"create"}}`,
    );
    expect(classifyRisks(events)[0]?.flags).toContain("iam");
  });
  it.each([
    "aws_secretsmanager_secret",
    "aws_ssm_parameter",
    "vault_generic_secret",
    "kubernetes_secret",
    "google_secret_manager_secret",
    "azurerm_key_vault_secret",
    "random_password",
    "tls_private_key",
    "b2_application_key",
    "github_actions_secret",
  ])("marks secret type %s high risk", (type) => {
    const events = parsePlanEvents(
      `{"type":"planned_change","change":{"resource":{"addr":"x","resource_type":"${type}"},"action":"create"}}`,
    );
    expect(classifyRisks(events)[0]?.flags).toContain("secret");
  });
});
