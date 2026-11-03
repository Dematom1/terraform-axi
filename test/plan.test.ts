import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePlanEvents, type PlanEvents } from "../src/plan/events.js";
import { classifyRisks, IAM_TYPES, isIamType, isSecretType, SECRET_TYPES } from "../src/plan/risk.js";
import { evaluateExpect, parseExpect } from "../src/plan/expect.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/plan/${name}.jsonl`, import.meta.url), "utf8");
const byAddress = (events: PlanEvents) =>
  Object.fromEntries(
    events.changes.map(({ address, action, reason }) => [address, reason ? `${action} ${reason}` : action]),
  );
const planned = (change: object) => parsePlanEvents(JSON.stringify({ type: "planned_change", change }));
const resource = { addr: "x.y", resource_type: "x" };

describe.each([
  ["terraform", "1.15.8"],
  ["tofu", "1.13.1"],
])("captured %s %s streams", (flavor, version) => {
  const load = (name: string) => parsePlanEvents(fixture(`${flavor}-${version}-${name}`));

  it("decodes every resource action with its reason", () => {
    const events = load("changes");
    expect(events).toMatchObject({ flavor, version, malformed: 0, unknownEvents: 0 });
    expect(byAddress(events)).toEqual({
      "terraform_data.new": "create",
      "terraform_data.keep": "update",
      "terraform_data.trigger": "update",
      "terraform_data.repl": "REPLACE cannot_update",
      "terraform_data.cbd": "REPLACE cannot_update",
      "terraform_data.triggered": "REPLACE replace_triggered_by",
      "terraform_data.gone": "DESTROY delete_because_no_resource_config",
      "data.terraform_remote_state.deferred": "read read_because_dependency_pending",
      "terraform_data.moved": "move",
      "terraform_data.imported": "import",
      "terraform_data.forgotten": "forget delete_because_no_resource_config",
    });
  });

  it("reads the summary and tolerates flavor-specific keys", () => {
    // A forget is not a destroy: Terraform and OpenTofu both leave it out of `remove`.
    expect(load("changes").summary).toEqual({
      add: 4,
      change: 2,
      destroy: 4,
      import: 1,
      ...(flavor === "tofu" ? { forget: 1 } : {}),
    });
  });

  it("ranks destroys, replaces, and the changed sensitive output first", () => {
    const rows = classifyRisks(load("changes"));
    const high = rows.filter((row) => row.level === "high").map((row) => `${row.address} ${row.flags.join(",")}`);
    expect(high.sort()).toEqual([
      "output.token secret",
      "terraform_data.cbd destroy,replace(cannot_update)",
      "terraform_data.gone destroy",
      "terraform_data.repl destroy,replace(cannot_update)",
      "terraform_data.triggered destroy,replace(replace_triggered_by)",
    ]);
    expect(rows.slice(0, 5).every((row) => row.level === "high")).toBe(true);
    expect(rows.slice(5).every((row) => row.level === "low")).toBe(true);
  });

  it("evaluates full, partial, and failing expectations", () => {
    const events = load("changes");
    expect(evaluateExpect(parseExpect("add=4,change=2,destroy=4"), events)).toEqual({ status: "pass", reasons: [] });
    expect(evaluateExpect(parseExpect("change=2"), events).status).toBe("pass");
    const result = evaluateExpect(parseExpect("destroy=0,change=2"), events);
    expect(result.status).toBe("fail");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/^destroy: expected 0, planned 4 \(/);
    expect(result.reasons[0]).toContain("terraform_data.repl REPLACE cannot_update");
    expect(result.reasons[0]).toContain("terraform_data.gone DESTROY delete_because_no_resource_config");
  });

  it("reports a no-change plan as zero counts", () => {
    const events = load("no-change");
    expect(events.changes).toEqual([]);
    expect(events.summary).toMatchObject({ add: 0, change: 0, destroy: 0 });
    expect(classifyRisks(events)).toEqual([]);
    expect(evaluateExpect(parseExpect("add=0,change=0,destroy=0"), events).status).toBe("pass");
  });

  it("reports an error-only stream as unavailable, never zero", () => {
    const events = load("error");
    expect(events.summary).toBe("unavailable");
    expect(events.changes).toEqual([]);
    expect(events.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", summary: "Reference to undeclared resource" }),
    ]);
    expect(evaluateExpect(parseExpect("add=0"), events)).toEqual({
      status: "fail",
      reasons: ["planned counts unavailable: the plan has no complete change summary"],
    });
  });

  it("decodes refresh-only drift separately from changes", () => {
    const events = load("drift");
    expect(events.drift).toEqual([{ address: "local_file.drifted", action: "DESTROY", type: "local_file" }]);
    expect(events.changes).toEqual([]);
    // change_summary is 0/0/0 even though drift exists; drift must be counted from resource_drift.
    expect(events.summary).toMatchObject({ add: 0, change: 0, destroy: 0 });
  });

  it("counts a truncated final line as malformed without keeping its content", () => {
    const raw = fixture(`${flavor}-${version}-truncated`);
    const events = load("truncated");
    expect(events.malformed).toBe(1);
    expect(events.diagnostics).toEqual([]);
    expect(events.summary).not.toBe("unavailable");
    const tail = raw.slice(raw.lastIndexOf("\n") + 1);
    expect(JSON.stringify(events)).not.toContain(
      tail.slice(tail.indexOf('"@message"'), tail.indexOf('"@message"') + 40),
    );
  });
});

describe("action decoding", () => {
  it.each([
    [{ action: "create" }, "create"],
    [{ action: "update" }, "update"],
    [{ action: "delete" }, "DESTROY"],
    [{ action: "replace" }, "REPLACE"],
    [{ action: "read" }, "read"],
    [{ action: "move" }, "move"],
    [{ action: "import" }, "import"],
    [{ action: "remove" }, "forget"],
    [{ actions: ["create"] }, "create"],
    [{ actions: ["update"] }, "update"],
    [{ actions: ["delete"] }, "DESTROY"],
    [{ actions: ["delete", "create"] }, "REPLACE"],
    [{ actions: ["create", "delete"] }, "REPLACE"],
    [{ actions: ["read"] }, "read"],
    [{ actions: ["forget"] }, "forget"],
  ])("decodes %j as %s", (shape, action) => {
    expect(planned({ resource, ...shape }).changes).toEqual([{ address: "x.y", type: "x", action }]);
  });

  it.each([{ action: "noop" }, { action: "no-op" }, { actions: ["no-op"] }])("drops no-op change %j", (shape) => {
    expect(planned({ resource, ...shape }).changes).toEqual([]);
  });

  // R5, review-1, F3: unrecognized values, alone or mixed with known ones, stay visible as unknown.
  it.each([
    [{ action: "provider-action" }, "provider-action"],
    [{ action: "constructor" }, "constructor"],
    [{ action: 5 }, "5"],
    [{}, "missing"],
    [{ actions: ["provider-action"] }, '["provider-action"]'],
    [{ actions: ["delete", "provider-action"] }, '["delete","provider-action"]'],
    [{ actions: ["create", "create"] }, '["create","create"]'],
    [{ actions: [] }, "[]"],
  ])("keeps unrecognized %j as unknown", (shape, raw) => {
    const events = parsePlanEvents(
      [
        JSON.stringify({ type: "planned_change", change: { resource, ...shape } }),
        JSON.stringify({ type: "resource_drift", change: { resource, ...shape } }),
        JSON.stringify({ type: "outputs", outputs: { token: { sensitive: true, ...shape } } }),
      ].join("\n"),
    );
    expect(events.changes).toEqual([{ address: "x.y", type: "x", action: "unknown", raw }]);
    expect(events.drift).toEqual(events.changes);
    expect(events.outputs).toEqual([{ name: "token", action: "unknown", sensitive: true, raw }]);
    expect(classifyRisks(events).map((row) => row.flags)).toEqual([["unknown"], ["secret"]]);
  });

  it.each([
    { type: "planned_change", change: { resource: {}, action: "create" } },
    { type: "resource_drift", change: { resource: {}, action: "delete" } },
    { type: "outputs", outputs: { token: null } },
  ])("marks malformed recognized events incomplete: %j", (event) => {
    const events = parsePlanEvents(
      [
        JSON.stringify(event),
        JSON.stringify({ type: "change_summary", changes: { add: 0, change: 0, remove: 0 } }),
      ].join("\n"),
    );
    expect(events.malformed).toBe(1);
    expect(evaluateExpect(parseExpect("add=0"), events).status).toBe("fail");
  });

  it("keeps legitimate no-op changes non-malformed", () => {
    const events = planned({ resource, action: "noop" });
    expect(events.changes).toEqual([]);
    expect(events.malformed).toBe(0);
  });

  it("bounds the kept raw value", () => {
    const raw = planned({ resource, action: "x".repeat(500) }).changes[0]?.raw;
    expect(raw).toHaveLength(65);
  });

  it.each([
    { actions: ["create", "delete", "read"], raw: '["create","delete","read"]' },
    { actions: ["provider-action", "create", "delete"], raw: '["provider-action","create","delete"]' },
  ])("keeps replacement with extra action values %j", ({ actions, raw }) => {
    const events = planned({ resource, actions, reason: "cannot_update" });
    expect(events.changes).toEqual([{ address: "x.y", type: "x", action: "REPLACE", reason: "cannot_update", raw }]);
    expect(classifyRisks(events)[0]?.flags).toEqual(["destroy", "replace(cannot_update)"]);
  });

  // F4: the reason is read with either action form, under either field name.
  it.each([
    { action: "replace", reason: "cannot_update" },
    { action: "replace", action_reason: "cannot_update" },
    { actions: ["delete", "create"], reason: "cannot_update" },
    { actions: ["create", "delete"], action_reason: "cannot_update" },
  ])("reads the replace reason from %j", (shape) => {
    const events = planned({ resource, ...shape });
    expect(events.changes).toEqual([{ address: "x.y", type: "x", action: "REPLACE", reason: "cannot_update" }]);
    expect(classifyRisks(events)[0]?.flags).toEqual(["destroy", "replace(cannot_update)"]);
  });
});

describe("outputs", () => {
  it("makes counts unavailable for an unrecognized output action", () => {
    const events = parsePlanEvents(
      [
        JSON.stringify({ type: "outputs", outputs: { token: { change: { actions: ["future-action"] } } } }),
        JSON.stringify({ type: "change_summary", changes: { add: 0, change: 0, remove: 0 } }),
      ].join("\n"),
    );
    expect(events.summary).toBe("unavailable");
    expect(evaluateExpect(parseExpect("add=0"), events).status).toBe("fail");
  });

  // F1: a sensitive output with a singular string action is a secret change.
  it.each([
    [{ action: "update" }, "update"],
    [{ action: "create" }, "create"],
    [{ action: "delete" }, "DESTROY"],
    [{ actions: ["update"] }, "update"],
    [{ change: { actions: ["update"] } }, "update"],
  ])("flags sensitive output %j as secret", (shape, action) => {
    const events = parsePlanEvents(
      JSON.stringify({ type: "outputs", outputs: { token: { sensitive: true, ...shape } } }),
    );
    expect(classifyRisks(events)).toEqual([{ address: "output.token", action, flags: ["secret"], level: "high" }]);
  });

  it.each([
    { sensitive: true, action: "noop" },
    { sensitive: true, change: { actions: ["no-op"] } },
    { sensitive: false, action: "update" },
  ])("does not flag output %j", (output) => {
    expect(classifyRisks(parsePlanEvents(JSON.stringify({ type: "outputs", outputs: { token: output } })))).toEqual([]);
  });
});

describe("change_summary", () => {
  const summary = (changes: object) => parsePlanEvents(JSON.stringify({ type: "change_summary", changes })).summary;

  it("keeps safe non-negative integer counts", () => {
    expect(
      summary({ add: 1, change: 2, remove: 3, import: 0, action_invocation: 3, future_key: 9, operation: "plan" }),
    ).toEqual({
      add: 1,
      change: 2,
      destroy: 3,
      import: 0,
    });
  });

  // F2: anything that is not a safe non-negative integer makes the whole summary unavailable.
  it.each([
    { add: 1.5, change: 0, remove: 0 },
    { add: -1, change: 0, remove: 0 },
    { add: Number.MAX_SAFE_INTEGER + 2, change: 0, remove: 0 },
    { add: "1", change: 0, remove: 0 },
    { add: 0, change: 0 },
    { add: 0, change: 0, destroy: 0 },
    { add: 0, change: 0, remove: 0, import: 1.5 },
    { add: 0, change: 0, remove: 0, forget: -1 },
  ])("treats %j as unavailable", (changes) => {
    expect(summary(changes)).toBe("unavailable");
  });

  it("is unavailable when the stream has no change_summary", () => {
    expect(
      parsePlanEvents(JSON.stringify({ type: "planned_change", change: { resource, action: "create" } })).summary,
    ).toBe("unavailable");
  });

  it.each(["planned_change", "resource_drift"])("rejects unknown actions in %s events", (type) => {
    const event = { type, change: { resource, action: "provider-sensitive-action" } };
    const summary = { type: "change_summary", changes: { add: 0, change: 0, remove: 0 } };
    expect(parsePlanEvents([JSON.stringify(event), JSON.stringify(summary)].join("\n")).summary).toBe("unavailable");
  });
});

describe("stream tolerance", () => {
  it("counts non-event lines as malformed without keeping their content", () => {
    const events = parsePlanEvents(["{garbage hunter2}", "[1,2]", '{"no":"type"}', "", '"str"'].join("\n"));
    expect(events.malformed).toBe(4);
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("tolerates unknown event types and counts them", () => {
    const events = parsePlanEvents(
      ['{"type":"future_event"}', '{"type":"refresh_start"}', '{"type":"log"}'].join("\n"),
    );
    expect(events).toMatchObject({ unknownEvents: 1, malformed: 0 });
  });

  it.each([
    { resource: {}, action: "create" },
    { addr: "x.y", action: "create" },
  ])("ignores change %j without change.resource.addr", (change) => expect(planned(change).changes).toEqual([]));
});

describe("type tables", () => {
  // One row per IAM_TYPES entry, in table order.
  it.each([
    ["aws_iam_role", "aws_iam_*"],
    ["google_storage_bucket_iam_member", "google_*_iam_*"],
    ["google_project_iam_binding", "google_project_iam_*"],
    ["azurerm_role_assignment", "azurerm_role_assignment"],
    ["azurerm_role_definition", "azurerm_role_definition"],
    ["kubernetes_cluster_role_binding", "kubernetes_*role*"],
    ["github_team_repository_permission", "github_*_permission*"],
  ])("IAM: %s matches %s", (type, pattern) => {
    expect(IAM_TYPES).toContain(pattern);
    expect(isIamType(type)).toBe(true);
  });

  // One row per SECRET_TYPES entry, in table order.
  it.each([
    ["aws_secretsmanager_secret_version", "aws_secretsmanager_*"],
    ["aws_ssm_parameter", "aws_ssm_parameter"],
    ["aws_iam_access_key", "aws_iam_access_key"],
    ["aws_kms_key", "aws_kms_*"],
    ["vault_generic_secret", "vault_*"],
    ["kubernetes_secret_v1", "kubernetes_secret*"],
    ["google_secret_manager_secret", "google_secret_manager_*"],
    ["azurerm_key_vault_secret", "azurerm_key_vault_*"],
    ["random_password", "random_password"],
    ["tls_private_key", "tls_private_key"],
    ["b2_application_key", "b2_application_key"],
    ["github_actions_environment_secret", "github_actions_*secret*"],
  ])("secret: %s matches %s", (type, pattern) => {
    expect(SECRET_TYPES).toContain(pattern);
    expect(isSecretType(type)).toBe(true);
  });

  it("covers every table entry with a row", () => {
    expect(IAM_TYPES).toHaveLength(7);
    expect(SECRET_TYPES).toHaveLength(12);
  });

  it.each([
    "google_iam",
    "github_permission",
    "azurerm_role_assignment_x",
    "aws_ssm_document",
    "kubernetes_config_map",
  ])("IAM: %s does not match", (type) => expect(isIamType(type)).toBe(false));

  it.each(["github_actions_workflow", "random_string", "aws_iam_access_key_x", "aws_kms", "kubernetes_service"])(
    "secret: %s does not match",
    (type) => expect(isSecretType(type)).toBe(false),
  );

  // F5: aws_iam_access_key is both an IAM and a secret type.
  it("flags aws_iam_access_key as iam and secret", () => {
    const events = planned({
      resource: { addr: "aws_iam_access_key.k", resource_type: "aws_iam_access_key" },
      action: "create",
    });
    expect(classifyRisks(events)[0]).toMatchObject({ flags: ["iam", "secret"], level: "high" });
  });

  it("does not flag reading a secret data source", () => {
    const events = planned({
      resource: { addr: "data.vault_generic_secret.s", resource_type: "vault_generic_secret" },
      action: "read",
    });
    expect(classifyRisks(events)[0]).toMatchObject({ flags: [], level: "low" });
  });
});

describe("--expect grammar", () => {
  it.each([
    ["add=1", { add: 1 }],
    ["destroy=0,add=2", { add: 2, destroy: 0 }],
    ["add=1,change=0,destroy=3", { add: 1, change: 0, destroy: 3 }],
  ])("parses %s", (input, counts) => expect(parseExpect(input)).toEqual(counts));

  it.each([
    ["", /empty/],
    ["add=1,", /empty item/],
    [",add=1", /empty item/],
    ["unknown=2", /"unknown" is unknown/],
    ["add", /needs a value/],
    ["add=", /needs a value/],
    ["add=1,add=2", /more than once/],
    ["add=-1", /negative/],
    ["add=1.5", /not a whole number/],
    ["add=1e3", /not a whole number/],
    ["add= 1", /not a whole number/],
    ["add=9007199254740993", /not a whole number/],
  ])("rejects %j", (input, message) => expect(() => parseExpect(input)).toThrow(message));

  it("bounds contributors to five and counts the rest", () => {
    const stream = Array.from({ length: 7 }, (_, i) =>
      JSON.stringify({ type: "planned_change", change: { resource: { addr: `a.${i}` }, action: "delete" } }),
    );
    stream.push(JSON.stringify({ type: "change_summary", changes: { add: 0, change: 0, remove: 7 } }));
    const [reason] = evaluateExpect(parseExpect("destroy=0"), parsePlanEvents(stream.join("\n"))).reasons;
    expect(reason).toBe(
      "destroy: expected 0, planned 7 (a.0 DESTROY, a.1 DESTROY, a.2 DESTROY, a.3 DESTROY, a.4 DESTROY, +2 more)",
    );
  });

  it("lists an unknown action as a contributor", () => {
    const stream = [
      JSON.stringify({ type: "planned_change", change: { resource, action: "provider-action" } }),
      JSON.stringify({ type: "change_summary", changes: { add: 1, change: 0, remove: 0 } }),
    ];
    expect(evaluateExpect(parseExpect("add=0"), parsePlanEvents(stream.join("\n"))).reasons).toEqual([
      "planned counts unavailable: the plan has no complete change summary",
    ]);
  });
});
