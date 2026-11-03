<h1 align="center">terraform-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm" src="https://img.shields.io/npm/v/terraform-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square" /></a>
</p>

Read-only Terraform and OpenTofu inspection for agents. Output is compact [TOON](https://toonformat.dev/) and follows [AXI](https://github.com/kunchenguid/axi) principles. CI tests Linux and macOS; Windows is not currently supported.

**Safety:** terraform-axi never applies or destroys. Secrets in Terraform state output are always redacted; configured wrapper text may be shown as entered. It never writes state to disk. `plan` runs `plan -json -input=false -lock=false -detailed-exitcode` (exit 2 means changes are present) and never writes a plan file (`TF_CLI_ARGS*` is not passed through, so the environment cannot add `-out`). `drift` runs the same plan with `-refresh-only`, so it compares state with real infrastructure, reports only drifted resource addresses and actions (never attribute values), and never writes state or plan files. `doctor` reports backend and credential diagnostics plus one unauthenticated DNS/TCP reachability check (unless `--offline`), without initializing Terraform or accessing state. A DNS timeout bounds the reported result; Node's system resolver lookup may continue after that result.

## Install and configure

Requires Node.js 20.19+.

```sh
npm install -g terraform-axi
terraform-axi setup --binary auto --wrapper 'just tf {module}' --module infra/prod
terraform-axi setup --remove-module infra/prod
terraform-axi setup status
terraform-axi setup hooks      # install user-level SessionStart hooks for supported agents
terraform-axi setup uninstall  # remove terraform-axi-managed user-level hooks only
```

The wrapper is optional. Use `{module}` as the module placeholder. Credentials are inherited by Terraform/OpenTofu from the environment. Never put credentials in arguments or config.

### Wrapper stdout and diagnostic safety

For `plan` and `drift`, wrappers must preserve complete, newline-delimited Terraform/OpenTofu JSON events and the Terraform exit code (0 = success, 2 = changes, 1 = error). Credential wrappers may initialize Terraform and inject credentials before invoking it. Send progress to stderr when possible. Plain-text stdout progress such as `Running terraform init...` is tolerated before, between, or after events and counted as `skipped_wrapper_lines`; its content is never emitted. This tolerance applies only to configured wrappers, not direct binaries or `--plan-json` files.

JSON-looking lines (starting with `{`, `[`, `"`, a number, or the literals `true`, `false`, `null`, after whitespace) must be valid JSON event objects. Malformed/truncated JSON, non-event JSON values, and streams without a valid change summary still fail as incomplete. Do not split an event across lines or prefix JSON with progress text. Arbitrary plain text cannot be distinguished from a wrapper log; the wrapper must not transform broken events into plain text. For version, state, and lint operations, keep stdout in the underlying command's format; this progress tolerance is specific to plan/drift streams.

Plan and drift diagnostics emit severity and a fixed category only, never provider-controlled summary, detail, or diagnostic address text. Failed subprocess stdout/stderr excerpts are withheld, including failures outside Terraform's normal exit codes. No environment-based secret guessing is used. Resource addresses retain structural names but withhold quoted instance keys; reason codes are allowlisted and unknown action text is withheld. `--full` expands the row limit, not diagnostic detail. There is no unsafe diagnostic-text opt-in; investigate provider errors separately in a trusted terminal.

Drift currently requires a live refresh-only plan; offline drift artifact input remains a follow-up. Offline plan review is available through `plan --plan-json`.

## Session memory

Each invocation that exits with a code other than 1 (runtime failure) or 2 (usage error) appends one line to `~/.config/terraform-axi/sessions.jsonl`: the command name, the module name when it is a configured module, a timestamp, and the first 12 hex characters of the SHA-256 of the agent session id. Argument values, paths outside the module registry, environment values, and raw session ids are never stored. The SessionStart hook exports the Claude Code session id through `CLAUDE_ENV_FILE`; without it, lines are unkeyed and do not count toward `last_session`. The home view and SessionStart context show `last_session`, the command and module counts of the most recent other session, and the home view recommends only implemented commands. There is no SessionEnd hook, no transcript reading, and no lock: `last_session` is derived from the log when it is read. The file rotates to `sessions.jsonl.1` above 1 MB, keeping one old generation.

`setup hooks` and `setup uninstall` rewrite agent settings files; concurrent setup runs are last-writer-wins.

## Commands

<!-- prettier-ignore -->
| Command                                                                                     | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `terraform-axi`                                                                             | Configured modules, wrapper, detected executable versions, and hints                                                   |
| `terraform-axi plan <module>`                                                               | Per-resource create/update/REPLACE/DESTROY/read rows; flags destroys, replacements, IAM, and secret-touching resources |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`                             | Assert planned counts (any subset); exits 1 with reasons on mismatch                                                   |
| `terraform-axi plan <module> [--binary terraform\|tofu] [--timeout seconds] [--full]`       | Run the binary directly instead of the wrapper, cap the plan time (default 1800s), or list every low-risk row          |
| `terraform-axi plan --plan-json <file>`                                                     | Same summary from a saved `show -json <planfile>` document or `plan -json` stream                                      |
| `terraform-axi drift <module> [--binary terraform\|tofu]`                                   | Drift from a refresh-only plan: drifted resources and a human-only accept command                                      |
| `terraform-axi lint <module> [--binary terraform\|tofu]`                                   | Read-only fmt check, initialized validate, and optional tflint; structured findings and count                         |
| `terraform-axi doctor [module] [--offline]`                                                  | Backend, credential and unauthenticated reachability diagnostics; no init or state access                              |
| `terraform-axi doctor --explain TEXT` or `--explain -`                                      | Explain a common S3 or Backblaze B2 diagnostic                                                                         |
| `terraform-axi state list <module> [--full]`                                                | List resource addresses; `--full` reads state JSON to infer types                                                       |
| `terraform-axi state resource <module> <address> [--full]`                                 | Inspect one resource with secrets redacted; strings truncate at 200 characters unless `--full`; `terraform_data` attributes except `id`, `arn`, and `name` are force-redacted |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                                                                      |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                                                                             |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level SessionStart hooks                                                  |

### Lint

`terraform-axi lint <module>` runs `fmt -check -no-color` (never rewrites files), then `validate -json -no-color` only when the module's `.terraform` directory exists (or `TF_DATA_DIR`, resolved relative to the module). An absent data directory reports validation as **skipped**, not passed. Lint never runs `init`, installs providers, or writes state. A data directory is only an initialization prerequisite: missing providers or modules still fail validation. Configured wrappers must target the same local module directory; `--binary terraform|tofu` bypasses the wrapper.

If `tflint` is on PATH, lint runs `tflint --format=json` in the module directory, without initialization or plugin installation; otherwise it reports **skipped**. Installed tflint failures are errors, not skips. Each subprocess has a 60-second deadline (binary selection probes retain their 2-second deadlines). Module contents are not changed by lint's commands; configured wrappers and tflint plugins are trusted executable code.

Output includes each check's status, a total finding `count`, and `findings` with `file`, `line`, `rule`, `severity`, and `message`. Locations unavailable from a tool are `null` (fmt lists files, not lines). An error finding exits 1; warnings alone exit 0. Skips remain explicit even when the exit code is 0, so a successful lint does not imply every check ran. Invalid arguments exit 2.

See [VISION.md](VISION.md) for product boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
