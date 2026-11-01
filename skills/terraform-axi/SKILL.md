---
name: terraform-axi
description: Read-only Terraform and OpenTofu CLI scaffold; plan, drift, doctor, and state commands are planned but not implemented.
---

# terraform-axi

Use terraform-axi for read-only infrastructure inspection. Never apply or destroy.

## Commands

| Command                                                                                     | Purpose                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `terraform-axi`                                                                             | Configured modules, wrapper, detected executable versions, and hints  |
| `terraform-axi plan <module>`                                                               | Planned change-risk summary (planned; not implemented)                |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`                             | Assert planned counts (planned; not implemented)                      |
| `terraform-axi drift <module>`                                                              | Drift summary (planned; not implemented)                              |
| `terraform-axi doctor <module>`                                                             | Backend and credential diagnostics (planned; not implemented)         |
| `terraform-axi state list <module>` / `state resource <address>`                            | State inspection with secrets redacted (planned; not implemented)     |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                     |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                            |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level SessionStart hooks |

See [VISION.md](../../VISION.md) for product boundaries and [CONTRIBUTING.md](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md) before contributing.
