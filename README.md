<h1 align="center">terraform-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm" src="https://img.shields.io/npm/v/terraform-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square" /></a>
</p>

Read-only Terraform and OpenTofu inspection for agents. Output is compact [TOON](https://toonformat.dev/) and follows [AXI](https://github.com/kunchenguid/axi) principles. CI tests Linux and macOS; Windows is not currently supported.

**Safety:** terraform-axi never applies or destroys. Secrets in Terraform state output are always redacted; configured wrapper text may be shown as entered. It never writes state to disk. This scaffold does not implement `plan`, `plan --expect`, `drift`, `doctor`, or `state`; those commands are planned for follow-up releases.

## Install and configure

Requires Node.js 20.19+.

```sh
npm install -g terraform-axi
terraform-axi setup --binary auto --wrapper 'just tf {module}'
terraform-axi setup status
terraform-axi setup hooks      # install user-level SessionStart hooks for supported agents
terraform-axi setup uninstall  # remove terraform-axi-managed user-level hooks only
```

The wrapper is optional. Use `{module}` as the module placeholder. Credentials are inherited by Terraform/OpenTofu from the environment; `_FILE` variants and credential commands will be supported by the diagnostic implementation. Never put credentials in arguments or config.

## Commands

| Command                                                          | Purpose                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `terraform-axi`                                                  | Configured modules, wrapper, detected executable versions, and hints  |
| `terraform-axi plan <module>`                                    | Planned change-risk summary (planned; not implemented)                |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`  | Assert planned counts (planned; not implemented)                      |
| `terraform-axi drift <module>`                                   | Drift summary (planned; not implemented)                              |
| `terraform-axi doctor <module>`                                  | Backend and credential diagnostics (planned; not implemented)         |
| `terraform-axi state list <module>` / `state resource <address>` | State inspection with secrets redacted (planned; not implemented)     |
| `terraform-axi setup` / `setup status`                           | Configure and inspect binary/wrapper settings                         |
| `terraform-axi setup hooks` / `setup uninstall`                  | Install or remove terraform-axi-managed user-level SessionStart hooks |

See [VISION.md](VISION.md) for product boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
