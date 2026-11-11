---
name: terraform-axi
description: Read-only Terraform and OpenTofu CLI; state list infers resource types by default, while --full reads state JSON to resolve them.
---

# terraform-axi

Use terraform-axi for read-only infrastructure inspection. Never apply or destroy.

See the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for the full command list.

## Commands

<!-- prettier-ignore -->
| Command                                                                                     | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `terraform-axi`                                                                             | Configured modules, wrapper, detected executable versions, and hints                                                   |
| `terraform-axi plan <module>`                                                               | Per-resource create/update/REPLACE/DESTROY/read rows; flags destroys, replacements, IAM, and secret-touching resources |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`                             | Assert planned counts (any subset); exits 1 with reasons on mismatch                                                   |
| `terraform-axi plan <module> [--binary terraform\|tofu] [--timeout seconds] [--full]`       | Run the binary directly instead of the wrapper, cap the plan time (default 1800s), or list every low-risk row          |
| `terraform-axi plan --plan-json <file>`                                                     | Same summary from a saved `show -json <planfile>` document or `plan -json` stream                                      |
| `terraform-axi drift <module> [--binary terraform\|tofu] [--full]`                                   | Drift from a refresh-only plan: drifted resources and a human-only accept command                                      |
| `terraform-axi lint <module> [--binary terraform\|tofu]`                                   | Read-only fmt check, initialized validate, and optional tflint; structured findings and count                         |
| `terraform-axi diagnose <file\|-> [--full]`                                                | Value-free failures (address, provider, operation, HTTP status, permission hint) and a plan/apply summary from a saved `plan\|apply -json` stream or text log |
| `terraform-axi doctor [module] [--offline]`                                                  | Backend, credential and unauthenticated reachability diagnostics; no init or state access                              |
| `terraform-axi doctor --explain TEXT` or `--explain -`                                      | Explain a common S3, Backblaze B2, GitHub permission, or AWS IAM diagnostic                                            |
| `terraform-axi state list <module> [--full]`                                                | List resource addresses; `--full` returns every resource and reads state JSON to resolve types                         |
| `terraform-axi state resource <module> <address> [--full]`                                 | Inspect one resource with secrets redacted; strings truncate at 200 characters unless `--full`; `terraform_data` attributes except `id`, `arn`, and `name` are force-redacted |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                                                                      |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                                                                             |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level session start/end integrations                                   |

Plan lists default to `address`, `action`, `type`, and `risk`, with all high-risk rows and the first 25 low-risk rows. `--fields address,action,flags,reason` selects explicit columns. `--full` returns every row and all detail fields unless `--fields` overrides them. Saved-plan recovery hints retain `--plan-json`, expectations, and field selectors.

Drift lists default to 20 rows and report the total drifted count. When truncated, the recovery command preserves the module and `--binary` selector; `--full` returns every drift row.

State lists default to 100 resources. Truncated attributes report their original character counts. Recovery hints preserve the module and address; `--full` never disables secret redaction. Usage errors exit 2, operational errors exit 1, and `--help` works alongside command input without running the operation.

### Lint

`terraform-axi lint <module>` runs `fmt -check -no-color` (never rewrites files), then `validate -json -no-color` only when the module's `.terraform` directory exists (or `TF_DATA_DIR`, resolved relative to the module). An absent data directory reports validation as **skipped**, not passed. Lint never runs `init`, installs providers, or writes state. A data directory is only an initialization prerequisite: missing providers or modules still fail validation. Configured wrappers must target the same local module directory; `--binary terraform|tofu` bypasses the wrapper.

If `tflint` is on PATH, lint runs `tflint --format=json` in the module directory, without initialization or plugin installation; otherwise it reports **skipped**. Installed tflint failures are errors, not skips. Each subprocess has a 60-second deadline (binary selection probes retain their 2-second deadlines). Module contents are not changed by lint's commands; configured wrappers and tflint plugins are trusted executable code.

Output includes each check's status, a total finding `count`, and `findings` with `file`, `line`, `rule`, `severity`, and `message`. Locations unavailable from a tool are `null` (fmt lists files, not lines). An error finding exits 1; warnings alone exit 0. Skips remain explicit even when the exit code is 0, so a successful lint does not imply every check ran. Invalid arguments exit 2.

### Diagnose

`terraform-axi diagnose <file|->` reads a saved `terraform apply -json` or `plan -json` stream (stdout) and reports why it failed without printing secrets. It never runs Terraform, reads state, or uses the network, so wrappers that withhold raw output can call it on the captured stream:

```sh
terraform apply -json -input=false plan.tfplan > apply.jsonl || terraform-axi diagnose apply.jsonl
```

Each failure lists the masked resource `address`, `provider`, `type`, `operation`, `http_status`, the request shape (`POST /orgs/*/actions/runner-groups`), AWS `error_code` and denied `missing_permission` from shipped known lists (otherwise `unrecognized`), a `summary` containing only words from a fixed safe vocabulary and HTTP status codes, and a fixed-text `cause`/`next` hint for known GitHub token-permission and AWS IAM errors. Source is shown as `file` or `stdin`; type/provider are emitted only when the address-derived type follows Terraform resource-type grammar and starts with a known provider name; otherwise the address prints as `withheld`. The summary reports plan counts, planned actions, apply outcomes, and error and warning counts; planned changes list masked addresses only. Output is allowlisted: attribute values, ids, diagnostic detail and snippets, URLs and hosts, quoted or bracketed text, and token-shaped words are never printed. A plain-text log is decoded best effort; non-JSON lines in a JSON stream are counted as `skipped_text_lines`. Failures and changes show 25 rows unless `--full`. Diagnose exits 0 when it read the input, whatever the apply's status.

See [VISION.md](../../VISION.md) for product boundaries and [CONTRIBUTING.md](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md) before contributing.
