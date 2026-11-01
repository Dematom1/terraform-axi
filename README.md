<h1 align="center">terraform-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm" src="https://img.shields.io/npm/v/terraform-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square" /></a>
</p>

Read-only Terraform and OpenTofu inspection for agents. Output is compact [TOON](https://toonformat.dev/) and follows [AXI](https://github.com/kunchenguid/axi) principles. CI tests Linux and macOS; Windows is not currently supported.

**Safety:** terraform-axi never applies or destroys. Secrets in Terraform state output are always redacted; configured wrapper text may be shown as entered. It never writes state to disk. `plan` runs `plan -json -input=false -lock=false` and never writes a plan file (`TF_CLI_ARGS*` is not passed through, so the environment cannot add `-out`). `drift`, `doctor`, and `state` are planned for follow-up releases.

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

The wrapper is optional. Use `{module}` as the module placeholder. Credentials are inherited by Terraform/OpenTofu from the environment; `_FILE` variants and credential commands will be supported by the diagnostic implementation. Never put credentials in arguments or config.

## Session memory

Each invocation that exits with a code other than 1 (runtime failure) or 2 (usage error) appends one line to `~/.config/terraform-axi/sessions.jsonl`: the command name, the module name when it is a configured module, a timestamp, and the first 12 hex characters of the SHA-256 of the agent session id. Argument values, paths outside the module registry, environment values, and raw session ids are never stored. The SessionStart hook exports the Claude Code session id through `CLAUDE_ENV_FILE`; without it, lines are unkeyed and do not count toward `last_session`. The home view and SessionStart context show `last_session`, the command and module counts of the most recent other session, and the home view recommends only implemented commands. There is no SessionEnd hook, no transcript reading, and no lock: `last_session` is derived from the log when it is read. The file rotates to `sessions.jsonl.1` above 1 MB, keeping one old generation.

`setup hooks` and `setup uninstall` rewrite agent settings files; concurrent setup runs are last-writer-wins.

## Commands

| Command                                                                                     | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `terraform-axi`                                                                             | Configured modules, wrapper, detected executable versions, and hints                                                   |
| `terraform-axi plan <module>`                                                               | Per-resource create/update/REPLACE/DESTROY/read rows; flags destroys, replacements, IAM, and secret-touching resources |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`                             | Assert planned counts (any subset); exits 1 with reasons on mismatch                                                   |
| `terraform-axi plan --plan-json <file>`                                                     | Same summary from a saved `show -json <planfile>` document or `plan -json` stream                                      |
| `terraform-axi drift <module>`                                                              | Drift summary (planned; not implemented)                                                                               |
| `terraform-axi doctor <module>`                                                             | Backend and credential diagnostics (planned; not implemented)                                                          |
| `terraform-axi state list <module>` / `state resource <address>`                            | State inspection with secrets redacted (planned; not implemented)                                                      |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                                                                      |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                                                                             |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level SessionStart hooks                                                  |

See [VISION.md](VISION.md) for product boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
