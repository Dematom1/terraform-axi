/**
 * Turns a saved `plan|apply -json` stream (or, best effort, a plain-text log) into value-free failure rows.
 *
 * Output is allowlisted: addresses go through `metadataAddress`, names and codes must match fixed shapes,
 * hints are fixed text from `explain`, and the provider summary keeps only plain words. Diagnostic `detail`,
 * snippets, attribute values, ids, URLs, hosts, and anything quoted are matched against but never printed.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { CliError, UsageError } from "../errors.js";
import { explain } from "../doctor/explain.js";
import {
  metadataAddress,
  parsePlanEvents,
  type AppliedResource,
  type PlanAction,
  type PlanDiagnostic,
  type PlanEvents,
} from "../plan/events.js";

export const diagnoseUsage = "terraform-axi diagnose <file|-> [--full]";
const MAX_ROWS = 25;
const MAX_WORDS = 40;

// Literal GitHub REST path words; every other segment (org, repo, id, name) prints as `*`.
const PATH_WORDS = new Set(
  "api v3 orgs repos enterprises users user teams actions runner-groups runners repositories secrets variables environments hooks members memberships collaborators invitations branches protection rulesets permissions installations apps keys deploy-keys labels milestones pages projects packages codespaces dependabot copilot settings properties schema values custom-properties outside_collaborators public_members".split(
    " ",
  ),
);
const SAFE_WORDS = new Set(
  "error creating updating deleting reading resource not found accessible by integration must have admin rights to repository organization permission denied forbidden unauthorized bad credentials invalid token scope operation response status code api user is authorized perform on with key request the a of for in provisioner local-exec reference undeclared deprecated argument iam get post put patch delete head http terraform open tofu github aws action actions runner group groups".split(
    " ",
  ),
);
const SAFE_TOKEN = /^(?:[a-z][a-z0-9-]*|[1-5]\d\d)$/i;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
// oxlint-disable-next-line no-control-regex -- strips ANSI color escapes from captured terminal logs
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const safeName = (value: string | undefined) => (value && NAME.test(value) ? value : undefined);

/** Keeps only plain words from provider text; everything else, including quoted or bracketed text, is `…`. */
export function safeText(text: string): string {
  const words = text
    .replace(ANSI, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, " … ")
    .replace(/"(?:[^"\\]|\\.)*"|(?<![A-Za-z])'[^'\n]*'|`[^`]*`|\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|<[^>]*>/g, " … ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const [, core, punctuation] = /^(.*?)([.,:;!?]*)$/.exec(token)!;
      return SAFE_TOKEN.test(core!) && (/^[1-5]\d\d$/.test(core!) || SAFE_WORDS.has(core!.toLowerCase()))
        ? `${core}${punctuation}`
        : "…";
    })
    .filter((word, index, all) => word !== "…" || all[index - 1] !== "…");
  return words.length > MAX_WORDS ? `${words.slice(0, MAX_WORDS).join(" ")} …` : words.join(" ");
}

function request(text: string): string | undefined {
  const match = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(https?:\/\/[^\s"'<>]+)/.exec(text);
  if (!match) return undefined;
  let path: string[];
  try {
    path = new URL(match[2]!.replace(/[:,.;]+$/, "")).pathname.split("/").filter(Boolean);
  } catch {
    return match[1];
  }
  return `${match[1]} /${path.map((segment) => (PATH_WORDS.has(segment) ? segment : "*")).join("/")}`;
}

function httpStatus(text: string): number | undefined {
  const match =
    /(?:\bStatusCode:?\s*|\bstatus(?: code)?:?\s+|\bHTTP(?:\/[\d.]+)?\s+|https?:\/\/\S+?:?\s+)([1-5]\d\d)\b/i.exec(
      text,
    );
  return match ? Number(match[1]) : undefined;
}

const IAM_ACTIONS = new Set(`iam:CreateRole iam:DeleteRole iam:GetRole iam:PassRole iam:AttachRolePolicy iam:DetachRolePolicy iam:PutRolePolicy iam:DeleteRolePolicy iam:CreatePolicy iam:DeletePolicy iam:CreatePolicyVersion iam:TagRole iam:CreateUser iam:CreateAccessKey iam:CreateServiceLinkedRole iam:CreateOpenIDConnectProvider iam:GetPolicy iam:ListRolePolicies iam:ListAttachedRolePolicies sts:AssumeRole sts:GetCallerIdentity sts:AssumeRoleWithWebIdentity s3:CreateBucket s3:DeleteBucket s3:PutObject s3:GetObject s3:DeleteObject s3:ListBucket s3:PutBucketPolicy s3:GetBucketPolicy s3:PutBucketVersioning s3:PutEncryptionConfiguration s3:PutBucketTagging s3:PutBucketPublicAccessBlock ec2:RunInstances ec2:TerminateInstances ec2:DescribeInstances ec2:CreateVpc ec2:DeleteVpc ec2:CreateSubnet ec2:CreateSecurityGroup ec2:AuthorizeSecurityGroupIngress ec2:CreateTags ec2:DescribeVpcs ec2:DescribeSubnets ec2:DescribeSecurityGroups kms:CreateKey kms:Decrypt kms:Encrypt kms:GenerateDataKey kms:DescribeKey kms:CreateAlias kms:ScheduleKeyDeletion kms:PutKeyPolicy secretsmanager:CreateSecret secretsmanager:GetSecretValue secretsmanager:PutSecretValue secretsmanager:DeleteSecret secretsmanager:DescribeSecret ssm:GetParameter ssm:PutParameter ssm:DeleteParameter ssm:GetParameters lambda:CreateFunction lambda:UpdateFunctionCode lambda:UpdateFunctionConfiguration lambda:AddPermission lambda:InvokeFunction lambda:GetFunction logs:CreateLogGroup logs:PutRetentionPolicy logs:DescribeLogGroups logs:DeleteLogGroup dynamodb:CreateTable dynamodb:DescribeTable dynamodb:DeleteTable dynamodb:PutItem dynamodb:GetItem route53:ChangeResourceRecordSets route53:CreateHostedZone route53:GetHostedZone route53:ListResourceRecordSets acm:RequestCertificate acm:DescribeCertificate ecr:CreateRepository ecr:GetAuthorizationToken ecs:CreateCluster ecs:CreateService ecs:RegisterTaskDefinition eks:CreateCluster eks:DescribeCluster rds:CreateDBInstance rds:DescribeDBInstances sns:CreateTopic sns:Publish sqs:CreateQueue sqs:SendMessage`.split(" "));
function missingPermission(text: string): string | undefined {
  if (!/not authorized to perform:?/.test(text)) return undefined;
  const action = /not authorized to perform:?\s+([a-z][a-z0-9-]{1,40}:[A-Z][A-Za-z0-9]*)\b/.exec(text)?.[1];
  return action ? IAM_ACTIONS.has(action) ? action : "unrecognized" : "unrecognized";
}

// Fixed AWS error codes; any other `api error <Code>:` capture is omitted.
const AWS_ERROR_CODES = new Set(
  "AccessDenied AccessDeniedException UnauthorizedOperation UnauthorizedAccess AuthFailure ExpiredToken ExpiredTokenException RequestExpired InvalidClientTokenId InvalidAccessKeyId SignatureDoesNotMatch Throttling ThrottlingException RequestLimitExceeded LimitExceeded LimitExceededException ServiceQuotaExceededException NoSuchEntity NoSuchBucket EntityAlreadyExists ResourceNotFoundException ResourceInUseException ValidationError ValidationException InvalidParameterValue InvalidParameterCombination MalformedPolicyDocument DependencyViolation OptInRequired".split(
    " ",
  ),
);
function errorCode(text: string): string | undefined {
  const match = /\bapi error ([A-Za-z]{3,60}):/.exec(text);
  return match ? AWS_ERROR_CODES.has(match[1]!) ? match[1] : "unrecognized" : undefined;
}

/** The resource type of a (masked) address, skipping `module.<name>` pairs and a `data.` prefix. */
function resourceType(address: string): string | undefined {
  const parts = address.replace(/\[[^\]]*\]/g, "").split(".");
  while (parts[0] === "module") parts.splice(0, 2);
  if (parts[0] === "data") parts.shift();
  const type = parts.length === 2 ? parts[0] : undefined;
  return type && /^[a-z][a-z0-9]{0,23}(?:_[a-z0-9]{1,24}){1,12}$/.test(type) ? type : undefined;
}

const OPERATION: Partial<Record<PlanAction | "noop", string>> = { DESTROY: "delete", REPLACE: "replace" };
const operation = (action: PlanAction | "noop") => OPERATION[action] ?? action;

function failure(diagnostic: PlanDiagnostic | undefined, hook: AppliedResource | undefined) {
  const text = diagnostic ? `${diagnostic.summary}\n${diagnostic.detail ?? ""}` : "";
  const rawAddress = diagnostic?.address ?? hook?.address;
  const maskedAddress = rawAddress ? metadataAddress(rawAddress) : undefined;
  const type = maskedAddress && maskedAddress !== "withheld" ? resourceType(maskedAddress) : undefined;
  const address = type ? maskedAddress : rawAddress ? "withheld" : undefined;
  const explanation = text ? explain(text) : undefined;
  const row: Record<string, string | number | undefined> = {
    address,
    provider: type?.split("_")[0],
    type,
    operation: hook ? operation(hook.action) : undefined,
    http_status: httpStatus(text),
    request: request(text),
    error_code: errorCode(text),
    missing_permission: missingPermission(text),
    summary: diagnostic ? safeText(diagnostic.summary) : "apply errored without a diagnostic",
    cause: explanation?.cause,
    next: explanation?.next,
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== ""));
}

const TEXT_ACTIONS: Record<string, PlanAction> = {
  "will be created": "create",
  "will be destroyed": "DESTROY",
  "will be updated in-place": "update",
  "must be replaced": "REPLACE",
  "will be read during apply": "read",
};
const HOOK_ACTIONS: Record<string, PlanAction> = {
  Creating: "create",
  Modifying: "update",
  Destroying: "DESTROY",
  Creation: "create",
  Modifications: "update",
  Destruction: "DESTROY",
};
const RESUME =
  /^(?:\S.*?: (?:Creating|Creation|Modifying|Modifications|Destroying|Destruction|Still|Refreshing|Reading|Read)\b|\s*# |Plan:|Apply complete!|No changes\.)/;
const counts = (...values: (string | undefined)[]) => values.map((value) => Number(value ?? 0));

/** Best-effort decoding of human Terraform/OpenTofu output into the event shape. */
export function parseTextLog(text: string): PlanEvents {
  const events: PlanEvents = {
    flavor: "unknown",
    changes: [],
    drift: [],
    summary: "unavailable",
    outputs: [],
    diagnostics: [],
    malformed: 0,
    unknownEvents: 0,
  };
  const started = new Map<string, PlanAction>();
  let open: PlanDiagnostic | undefined;
  let detail: string[] = [];
  const close = () => {
    if (open && detail.length) open.detail = detail.join("\n");
    [open, detail] = [undefined, []];
  };
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    const start = /^[│|]?\s*(Error|Warning): (.*)$/.exec(raw);
    if (start) {
      close();
      open = { severity: start[1]!.toLowerCase(), summary: start[2]! };
      events.diagnostics.push(open);
      continue;
    }
    if (open) {
      if (/^╵/.test(raw)) {
        close();
        continue;
      }
      const address = /^[│|]?\s+with (\S.*),\s*$/.exec(raw);
      if (address && !open.address) {
        open.address = address[1]!;
        continue;
      }
      // Detail runs until Terraform resumes progress output; it is only matched, so over-capture is harmless.
      if (!RESUME.test(raw)) {
        detail.push(raw);
        continue;
      }
      close();
    }
    const planned =
      /^\s*# (.+?) (will be created|will be destroyed|will be updated in-place|must be replaced|will be read during apply)\b/.exec(
        raw,
      );
    if (planned) {
      events.changes.push({ address: planned[1]!, action: TEXT_ACTIONS[planned[2]!]! });
      continue;
    }
    const begun = /^(\S.*?): (Creating|Modifying|Destroying)\.\.\./.exec(raw);
    if (begun) {
      started.set(begun[1]!, HOOK_ACTIONS[begun[2]!]!);
      continue;
    }
    const hook = /^(\S.*?): (Creation|Modifications|Destruction) (complete|errored) after\b/.exec(raw);
    if (hook) {
      started.delete(hook[1]!);
      (events.applied ??= []).push({
        address: hook[1]!,
        action: HOOK_ACTIONS[hook[2]!]!,
        outcome: hook[3] === "errored" ? "errored" : "complete",
      });
      continue;
    }
    const plan = /\bPlan:(?: (\d+) to import,)? (\d+) to add, (\d+) to change, (\d+) to destroy\b/.exec(raw);
    if (plan) {
      const [imports, add, change, destroy] = counts(plan[1], plan[2], plan[3], plan[4]);
      events.summary = { add: add!, change: change!, destroy: destroy!, ...(imports ? { import: imports } : {}) };
    } else if (/^No changes\./.test(raw.trim())) events.summary = { add: 0, change: 0, destroy: 0 };
    const apply =
      /\bApply complete! Resources:(?: (\d+) imported,)? (\d+) added, (\d+) changed, (\d+) destroyed\b/.exec(raw);
    if (apply) {
      const [imports, add, change, destroy] = counts(apply[1], apply[2], apply[3], apply[4]);
      events.applySummary = { add: add!, change: change!, destroy: destroy!, ...(imports ? { import: imports } : {}) };
    }
  }
  close();
  // Human output prints no "errored" line: a resource that started, never finished, and is named by an error failed.
  for (const [address, action] of started)
    if (events.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.address === address))
      (events.applied ??= []).push({ address, action, outcome: "errored" });
  return events;
}

const isEventLine = (line: string) => {
  try {
    const event: unknown = JSON.parse(line);
    return event !== null && typeof event === "object" && typeof (event as { type?: unknown }).type === "string";
  } catch {
    return false;
  }
};

export function renderDiagnosis(
  events: PlanEvents,
  options: { source: string; input: "json" | "text"; full: boolean; invocation: string },
): Record<string, unknown> {
  const errors = events.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = events.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const applied = events.applied ?? [];
  const errored = applied.filter((row) => row.outcome === "errored");
  const hookFor = (address: string | undefined) =>
    address === undefined
      ? undefined
      : (errored.find((row) => row.address === address) ?? applied.find((row) => row.address === address));
  const attributed = new Set<AppliedResource>();
  const rows = errors.map((diagnostic) => {
    // A lone error with a lone errored resource belongs to it even when the diagnostic names no address.
    const hook =
      hookFor(diagnostic.address) ??
      (errors.length === 1 && errored.length === 1 && !diagnostic.address ? errored[0] : undefined);
    if (hook) attributed.add(hook);
    return failure(diagnostic, hook);
  });
  for (const hook of errored) if (!attributed.has(hook)) rows.push(failure(undefined, hook));

  const report: Record<string, unknown> = { source: options.source, input: options.input };
  if (events.version)
    report.version = events.flavor === "unknown" ? events.version : `${events.flavor} ${events.version}`;
  const recognized =
    events.diagnostics.length ||
    events.changes.length ||
    applied.length ||
    events.summary !== "unavailable" ||
    events.applySummary;
  report.status = rows.length ? "failed" : events.malformed ? "incomplete" : recognized ? "ok" : "unrecognized";
  const byAction: Record<string, number> = {};
  for (const change of events.changes)
    byAction[operation(change.action)] = (byAction[operation(change.action)] ?? 0) + 1;
  const summary: Record<string, unknown> = { plan: events.summary };
  if (Object.keys(byAction).length) summary.planned = byAction;
  if (events.applySummary || applied.length) {
    summary.apply = events.applySummary ?? "unavailable";
    summary.applied = { complete: applied.length - errored.length, errored: errored.length };
  }
  summary.errors = errors.length;
  summary.warnings = warnings;
  report.summary = summary;
  const shown = options.full ? rows : rows.slice(0, MAX_ROWS);
  report.failures = shown.length ? shown : "none";
  if (shown.length < rows.length) report.failures_omitted = rows.length - shown.length;
  const changes = events.changes.map((change) => {
    const maskedAddress = metadataAddress(change.address);
    const type = maskedAddress !== "withheld" ? resourceType(maskedAddress) : undefined;
    return { address: type ? maskedAddress : "withheld", action: operation(change.action), type: type ?? "" };
  });
  if (changes.length) {
    report.changes = options.full ? changes : changes.slice(0, MAX_ROWS);
    if (!options.full && changes.length > MAX_ROWS) report.changes_omitted = changes.length - MAX_ROWS;
  }
  if (events.skippedWrapperOutput) report.skipped_text_lines = events.skippedWrapperOutput;
  if (events.malformed) report.malformed_lines = events.malformed;
  if (events.unknownEvents) report.unknown_events = events.unknownEvents;

  const help: string[] = [];
  if (!options.full && (rows.length > MAX_ROWS || changes.length > MAX_ROWS))
    help.push(`Run \`${options.invocation} --full\` to list every failure and change`);
  if (report.status === "unrecognized")
    help.push(
      "No Terraform events or diagnostics recognized; save `terraform apply -json` (or `plan -json`) stdout and rerun",
    );
  if (options.input === "text")
    help.push("Plain-text logs are decoded best effort; save `-json` output for complete failure attribution");
  if (rows.length)
    help.push("Fix the reported failures, then review a fresh `terraform-axi plan <module>` before retrying the apply");
  if (help.length) report.help = help;
  return report;
}

export async function diagnose(args: string[]): Promise<Record<string, unknown>> {
  // `-` (stdin) is an operand, but the shared parser treats any leading dash as a flag.
  const parsed = parseArgs(
    args.filter((arg) => arg !== "-"),
    [{ name: "--full", boolean: true }],
  );
  const operands = [...(parsed.command === undefined ? [] : [parsed.command]), ...parsed.positional];
  const dashes = args.filter((arg) => arg === "-").length;
  if (operands.length + dashes !== 1)
    throw new UsageError(`expected exactly one log file or -; usage: ${diagnoseUsage}`);
  const source = operands[0] ?? "-";
  let text: string;
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    try {
      text = readFileSync(source, "utf8");
    } catch {
      throw new CliError("cannot read log file");
    }
  }
  const full = parsed.values["--full"] !== undefined;
  const json = text.split(/\r?\n/).some(isEventLine);
  return renderDiagnosis(json ? parsePlanEvents(text, true) : parseTextLog(text), {
    source: source === "-" ? "stdin" : "file",
    input: json ? "json" : "text",
    full,
    invocation: "terraform-axi diagnose <file|->",
  });
}
