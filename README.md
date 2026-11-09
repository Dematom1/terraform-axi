<h1 align="center">terraform-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm" src="https://img.shields.io/npm/v/terraform-axi?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm weekly downloads" src="https://img.shields.io/npm/dw/terraform-axi?style=flat-square" /></a>
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
terraform-axi setup hooks      # install user-level session start/end integrations
terraform-axi setup uninstall  # remove terraform-axi-managed user-level hooks only
```

The wrapper is optional. Use `{module}` as the module placeholder. Credentials are inherited by Terraform/OpenTofu from the environment. Never put credentials in arguments or config.

### Wrapper stdout and diagnostic safety

For `plan` and `drift`, wrappers must preserve complete, newline-delimited Terraform/OpenTofu JSON events and the Terraform exit code (0 = success, 2 = changes, 1 = error). Credential wrappers may initialize Terraform and inject credentials before invoking it. Send progress to stderr when possible. Plain-text stdout progress such as `Running terraform init...` is tolerated before, between, or after events and counted as `skipped_wrapper_lines`; its content is never emitted. This tolerance applies only to configured wrappers, not direct binaries or `--plan-json` files.

JSON-looking lines (starting with `{`, `[`, `"`, a number, or the literals `true`, `false`, `null`, after whitespace) must be valid JSON event objects. Malformed/truncated JSON, non-event JSON values, and streams without a valid change summary still fail as incomplete. Do not split an event across lines or prefix JSON with progress text. Arbitrary plain text cannot be distinguished from a wrapper log; the wrapper must not transform broken events into plain text. For version, state, and lint operations, keep stdout in the underlying command's format; this progress tolerance is specific to plan/drift streams.

Plan and drift diagnostics emit severity and a fixed category only, never provider-controlled summary, detail, or diagnostic address text. Failed subprocess stdout/stderr excerpts are withheld, including failures outside Terraform's normal exit codes. No environment-based secret guessing is used. Resource addresses retain structural names but withhold quoted instance keys; reason codes are allowlisted and unknown action text is withheld. `--full` expands the row limit, not diagnostic detail. There is no unsafe diagnostic-text opt-in; investigate provider errors separately in a trusted terminal.

Drift currently requires a live refresh-only plan; offline drift artifact input remains a follow-up. Offline plan review is available through `plan --plan-json`.

## Session memory

Ordinary commands and SessionStart context, including `setup status`, do not write configuration or session telemetry. Setup actions change configuration. `setup hooks` opts into SessionEnd capture for Claude Code and Codex, and session-idle/deleted capture for OpenCode 1 and 2. Each completed session has an atomic, mode-0600 summary under `~/.config/terraform-axi/captures/`. Separate files prevent concurrent sessions from overwriting each other.

Capture reads at most the last 1 MB of a supplied transcript. It retains only recognized terraform-axi command counts, a count of files touched by Write/Edit tools, transcript byte counts, the directory, a hashed session key, and the completion time. It never stores transcript text, arguments, credentials, or file names. OpenCode captures command counts from tool events instead. The next session in the same directory sees this summary as `last_session`. Unsupported transcript records are ignored; counts describe recognized records in the scanned tail, not a complete audit log.

Ambient context shows only registered modules containing the current directory. New `setup --module` registrations retain the module label and store its absolute directory separately. Re-register older relative registrations from their original working directory to enable directory-scoped context. SessionStart no longer writes `CLAUDE_ENV_FILE`. The home view can still read legacy `sessions.jsonl` history, but ambient context uses only directory-scoped captures.

`setup hooks` and `setup uninstall` rewrite agent settings files; concurrent setup runs are last-writer-wins. Stored hook commands use absolute paths so they work after npx exits; after moving the installation, run `setup hooks` again to refresh every agent integration.

Known SDK limitation: `axi-sdk-js` 0.1.13 does not honor `CLAUDE_CONFIG_DIR`. Hook installation, status, and removal use `~/.claude/settings.json`, not a custom Claude directory. Custom-directory SessionStart integration remains unsupported until the SDK adds support.

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
| `terraform-axi state list <module> [--full]`                                                | List resource addresses; `--full` returns every resource and reads state JSON to resolve types                         |
| `terraform-axi state resource <module> <address> [--full]`                                 | Inspect one resource with secrets redacted; strings truncate at 200 characters unless `--full`; `terraform_data` attributes except `id`, `arn`, and `name` are force-redacted |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                                                                      |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                                                                             |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level session start/end integrations                                   |

Plan lists default to `address`, `action`, `type`, and `risk`, with all high-risk rows and the first 25 low-risk rows. `--fields address,action,flags,reason` selects explicit columns. `--full` returns every row and all detail fields unless `--fields` overrides them. Saved-plan recovery hints retain `--plan-json`, expectations, and field selectors.

State lists default to 100 resources. Truncated attributes report their original character counts. Recovery hints preserve the module and address; `--full` never disables secret redaction. Usage errors exit 2, operational errors exit 1, and `--help` works alongside command input without running the operation.

### Lint

`terraform-axi lint <module>` runs `fmt -check -no-color` (never rewrites files), then `validate -json -no-color` only when the module's `.terraform` directory exists (or `TF_DATA_DIR`, resolved relative to the module). An absent data directory reports validation as **skipped**, not passed. Lint never runs `init`, installs providers, or writes state. A data directory is only an initialization prerequisite: missing providers or modules still fail validation. Configured wrappers must target the same local module directory; `--binary terraform|tofu` bypasses the wrapper.

If `tflint` is on PATH, lint runs `tflint --format=json` in the module directory, without initialization or plugin installation; otherwise it reports **skipped**. Installed tflint failures are errors, not skips. Each subprocess has a 60-second deadline (binary selection probes retain their 2-second deadlines). Module contents are not changed by lint's commands; configured wrappers and tflint plugins are trusted executable code.

Output includes each check's status, a total finding `count`, and `findings` with `file`, `line`, `rule`, `severity`, and `message`. Locations unavailable from a tool are `null` (fmt lists files, not lines). An error finding exits 1; warnings alone exit 0. Skips remain explicit even when the exit code is 0, so a successful lint does not imply every check ran. Invalid arguments exit 2.

See [VISION.md](VISION.md) for product boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
