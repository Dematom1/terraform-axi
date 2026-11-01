import type { PlanChange, PlanEvents } from "./events.js";

export type ExpectKey = "add" | "change" | "destroy";
export type ExpectedCounts = Partial<Record<ExpectKey, number>>;
export type ExpectResult = { status: "pass" | "fail"; reasons: string[] };

const KEYS: readonly string[] = ["add", "change", "destroy"] satisfies ExpectKey[];
const MAX_CONTRIBUTORS = 5;

/**
 * Parses `add=N,change=N,destroy=N`, any non-empty subset in any order.
 * Rejects empty input, empty items, unknown keys, duplicates, negative values, and non-integers.
 */
export function parseExpect(input: string): ExpectedCounts {
  if (input === "") throw new Error("--expect is empty; use add=N,change=N,destroy=N or a subset");
  const parsed: ExpectedCounts = {};
  for (const item of input.split(",")) {
    const eq = item.indexOf("=");
    const key = eq === -1 ? item : item.slice(0, eq);
    const value = eq === -1 ? undefined : item.slice(eq + 1);
    if (item === "") throw new Error(`--expect has an empty item in "${input}"`);
    if (!KEYS.includes(key)) throw new Error(`--expect key "${key}" is unknown; use add, change, or destroy`);
    if (key in parsed) throw new Error(`--expect key "${key}" is given more than once`);
    if (value === undefined || value === "") throw new Error(`--expect ${key} needs a value, e.g. ${key}=0`);
    if (value.startsWith("-")) throw new Error(`--expect ${key}=${value} is negative`);
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
      throw new Error(`--expect ${key}=${value} is not a whole number`);
    parsed[key as ExpectKey] = number;
  }
  return parsed;
}

// A replace counts toward both add and destroy, matching Terraform's own "N to add, N to destroy" summary.
// An unknown action may sit behind any count, so it is listed as a contributor to every mismatch.
const contributes: Record<ExpectKey, (row: PlanChange) => boolean> = {
  add: (row) => row.action === "create" || row.action === "REPLACE" || row.action === "unknown",
  change: (row) => row.action === "update" || row.action === "unknown",
  destroy: (row) => row.action === "DESTROY" || row.action === "REPLACE" || row.action === "unknown",
};

const describe = (row: PlanChange) =>
  [row.address, row.action, row.action === "unknown" ? row.raw : row.reason].filter(Boolean).join(" ");

/** Compares expected counts with the stream's `change_summary`. A missing summary fails, never counts as 0. */
export function evaluateExpect(expected: ExpectedCounts, events: PlanEvents): ExpectResult {
  const { summary } = events;
  if (summary === "unavailable")
    return { status: "fail", reasons: ["planned counts unavailable: the plan has no complete change summary"] };
  const reasons: string[] = [];
  for (const key of KEYS as ExpectKey[]) {
    const want = expected[key];
    if (want === undefined || want === summary[key]) continue;
    const rows = events.changes.filter(contributes[key]);
    const shown = rows.slice(0, MAX_CONTRIBUTORS).map(describe);
    if (rows.length > shown.length) shown.push(`+${rows.length - shown.length} more`);
    reasons.push(`${key}: expected ${want}, planned ${summary[key]}${shown.length ? ` (${shown.join(", ")})` : ""}`);
  }
  return { status: reasons.length ? "fail" : "pass", reasons };
}
