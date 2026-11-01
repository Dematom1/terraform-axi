import type { PlanEvents } from "./events.js";

export type ExpectedCounts = Partial<Record<"add" | "change" | "destroy", number>>;
export type ExpectResult = { status: "pass" | "fail"; reasons: string[] };

export function parseExpect(input: string): ExpectedCounts {
  if (!input.trim()) throw new Error("expected at least one count");
  const parsed: ExpectedCounts = {};
  for (const part of input.split(",")) {
    const match = /^(add|change|destroy)=(0|[1-9]\d*)$/.exec(part);
    if (!match) throw new Error(`invalid expected count: ${part}`);
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid expected count: ${part}`);
    const key = match[1] as keyof ExpectedCounts;
    if (key in parsed) throw new Error(`duplicate expected count: ${key}`);
    parsed[key] = value;
  }
  return parsed;
}

export function evaluateExpect(expected: ExpectedCounts, events: PlanEvents): ExpectResult {
  if (events.summary === "unavailable")
    return { status: "fail", reasons: ["planned counts unavailable (missing change_summary)"] };
  const counts = {
    add: events.summary.add,
    change: events.summary.change,
    destroy: events.summary.destroy ?? events.summary.remove,
  };
  const reasons = Object.entries(expected).flatMap(([key, count]) => {
    const planned = counts[key as keyof typeof counts];
    if (planned === count) return [];
    const contributors = events.changes
      .filter((row) =>
        key === "destroy"
          ? row.action === "DESTROY" || row.action === "REPLACE"
          : key === "add"
            ? row.action === "create" || row.action === "REPLACE"
            : row.action === "update",
      )
      .slice(0, 5)
      .map((row) => `${row.address} ${row.action}${row.reason ? ` ${row.reason}` : ""}`);
    return [
      `${key}: expected ${count}, planned ${planned}${contributors.length ? ` (${contributors.join(", ")})` : ""}`,
    ];
  });
  return { status: reasons.length ? "fail" : "pass", reasons };
}
