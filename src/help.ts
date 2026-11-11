import { PLAN_ARGS, usage as planUsage } from "./plan/command.js";
import { DRIFT_ARGS, driftUsage } from "./commands/drift.js";
import { lintUsage } from "./commands/lint.js";
import { diagnoseUsage } from "./commands/diagnose.js";

/** Shared by --help and usage errors so the correction is available in one response. */
export function commandHelp(
  command: string,
  subcommand?: string,
): { usage: string; flags: string[]; defaults: string; examples: string[]; help?: string[]; [key: string]: unknown } {
  const universal = "--help: show this reference without running the operation";
  switch (command) {
    case "plan":
      return {
        usage: planUsage,
        flags: [
          "--plan-json <file>: read a saved JSON plan instead of running a module",
          "--expect add=N,change=N,destroy=N: assert counts",
          "--binary terraform|tofu: bypass configured wrapper",
          "--timeout <seconds>",
          "--full: all rows and detail fields",
          "--fields address,action,type,risk,flags,reason: select columns",
          universal,
        ],
        defaults:
          "1800 seconds; all high-risk rows and first 25 low-risk rows; fields address,action,type,risk; configured binary/wrapper (auto if unset)",
        runs: PLAN_ARGS.join(" "),
        diagnostics:
          "metadata only; provider text and subprocess excerpts withheld; --full lists rows, not diagnostic text",
        wrapper_stdout:
          "plain-text progress counted as skipped_wrapper_lines; JSON-looking lines must be complete JSON events; prefer progress on stderr",
        never: "apply, destroy, -out plan files, state writes",
        examples: [
          "terraform-axi plan infra/prod --expect add=0,change=0,destroy=0",
          "terraform-axi plan --plan-json plan.json --full",
          "terraform-axi plan infra/prod --fields address,action,flags,reason",
        ],
      };
    case "drift":
      return {
        usage: driftUsage,
        flags: ["--binary terraform|tofu: bypass configured wrapper", "--full: all drift rows", universal],
        defaults: "600 seconds; first 20 drift rows (--full lists all); configured binary/wrapper (auto if unset)",
        runs: DRIFT_ARGS.join(" "),
        diagnostics: "metadata only; provider text and subprocess excerpts withheld",
        wrapper_stdout:
          "plain-text progress counted as skipped_wrapper_lines; JSON-looking lines must be complete JSON events; prefer progress on stderr",
        never: "apply, refresh, -out plan files, state writes",
        examples: [
          "terraform-axi drift infra/prod",
          "terraform-axi drift infra/prod --full",
          "terraform-axi drift . --binary tofu --full",
        ],
      };
    case "lint":
      return {
        usage: lintUsage,
        flags: ["--binary terraform|tofu: bypass configured wrapper", universal],
        defaults: "60 seconds per check; configured binary/wrapper (auto if unset)",
        runs: "fmt -check; validate -json only with a data directory; tflint if installed",
        never: "init or format writes",
        examples: ["terraform-axi lint infra/prod", "terraform-axi lint . --binary tofu"],
      };
    case "diagnose":
      return {
        usage: diagnoseUsage,
        flags: ["-: read the log from stdin", "--full: all failure and planned-change rows", universal],
        defaults:
          "first 25 failures and planned changes; JSON event stream when any line is a Terraform event, else plain text",
        reads: "a saved `plan -json` or `apply -json` stream (stdout), or a plain-text log best effort",
        output:
          "address, provider, type, operation, HTTP status, request path shape, AWS error code and denied action, plain-word summary, fixed-text hint",
        never:
          "attribute values, ids, diagnostic detail or snippets, URLs, hosts, quoted text, env; no Terraform run, state access, or network",
        examples: [
          "terraform apply -json plan.tfplan > apply.jsonl; terraform-axi diagnose apply.jsonl",
          "terraform-axi diagnose - < apply.jsonl",
          "terraform-axi diagnose apply.log --full",
        ],
      };
    case "doctor":
      return {
        usage: "terraform-axi doctor [module] [--offline] | --explain TEXT|-",
        flags: [
          "--offline: skip backend network probe",
          "--explain TEXT|-: explain text or stdin without echoing it; cannot combine with module/--offline",
          universal,
        ],
        defaults: "module optional; network probe enabled for a module; credentials reported by presence only",
        examples: [
          "terraform-axi doctor infra/prod --offline",
          "terraform-axi doctor --explain -",
          "terraform-axi doctor infra/prod",
        ],
      };
    case "state": {
      const resource = subcommand === "resource";
      const usage = resource
        ? "terraform-axi state resource <module> <address> [--full]"
        : subcommand === "list"
          ? "terraform-axi state list <module> [--full]"
          : "terraform-axi state list <module> [--full] | state resource <module> <address> [--full]";
      const examples = resource
        ? [
            "terraform-axi state resource infra/prod terraform_data.example",
            "terraform-axi state resource infra/prod terraform_data.example --full",
          ]
        : [
            "terraform-axi state list infra/prod",
            "terraform-axi state list infra/prod --full",
            "terraform-axi state resource infra/prod terraform_data.example",
          ];
      const detail = resource
        ? "--full: include untruncated attributes; secrets remain redacted."
        : "--full: list every resource and resolve types from state.";
      return {
        usage,
        flags: [detail, universal],
        defaults: resource
          ? "attribute previews 200 characters; secrets always redacted"
          : subcommand === "list"
            ? "100 rows; types inferred from addresses"
            : "100 list rows; attribute previews 200 characters; secrets always redacted",
        examples,
        help: [resource ? "Required: module and resource address." : "Required: module.", detail, ...examples],
      };
    }
    case "setup": {
      if (subcommand && ["status", "hooks", "uninstall"].includes(subcommand)) {
        const purpose =
          subcommand === "status"
            ? "Read-only; reports configuration and managed hooks."
            : subcommand === "hooks"
              ? "Writes or repairs user-level SessionStart and SessionEnd integrations for Claude Code, Codex, and OpenCode."
              : "Removes managed integrations; preserves unrelated settings.";
        const examples = [`terraform-axi setup ${subcommand}`, `terraform-axi setup ${subcommand} --help`];
        return {
          usage: `terraform-axi setup ${subcommand} [--help]`,
          flags: [universal],
          defaults: "user scope; no positional arguments",
          examples,
          help: [purpose, ...examples],
        };
      }
      return {
        usage:
          "terraform-axi setup [--binary terraform|tofu|auto] [--wrapper command] [--module name] [--remove-module name] | setup hooks|status|uninstall",
        flags: [
          "--binary terraform|tofu|auto",
          "--wrapper <command>: requires {module} placeholder",
          "--module <path>: repeatable",
          "--remove-module <path>: repeatable",
          universal,
        ],
        defaults: "binary auto; no wrapper or modules on first run; hooks require explicit setup hooks",
        examples: [
          "terraform-axi setup --binary tofu --module infra/prod",
          "terraform-axi setup hooks",
          "terraform-axi setup status",
        ],
      };
    }
    default:
      return {
        usage: "terraform-axi update [--check|--dry-run]",
        flags: ["--check: report current vs latest without installing", "--dry-run: alias for --check", universal],
        defaults: "detect installation manager before updating; registry request timeout 20 seconds",
        examples: ["terraform-axi update", "terraform-axi update --check", "terraform-axi update --dry-run"],
      };
  }
}
