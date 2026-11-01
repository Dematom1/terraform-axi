---
name: terraform-axi
description: Read-only Terraform and OpenTofu CLI; state list and resource inspection are implemented.
---

# terraform-axi

Use terraform-axi for read-only infrastructure inspection. Never apply or destroy.

See the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for the full command list.

## Commands

| Command                                                                                     | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `terraform-axi`                                                                             | Configured modules, wrapper, detected executable versions, and hints                                                   |
| `terraform-axi plan <module>`                                                               | Per-resource create/update/REPLACE/DESTROY/read rows; flags destroys, replacements, IAM, and secret-touching resources |
| `terraform-axi plan <module> --expect add=N,change=N,destroy=N`                             | Assert planned counts (any subset); exits 1 with reasons on mismatch                                                   |
| `terraform-axi plan <module> [--binary terraform\|tofu] [--timeout seconds] [--full]`       | Run the binary directly instead of the wrapper, cap the plan time (default 1800s), or list every low-risk row          |
| `terraform-axi plan --plan-json <file>`                                                     | Same summary from a saved `show -json <planfile>` document or `plan -json` stream                                      |
| `terraform-axi drift <module> [--binary terraform\|tofu]`                                   | Drift from a refresh-only plan: drifted resources and a human-only accept command                                      |
| `terraform-axi doctor <module>`                                                             | Backend and credential diagnostics (planned; not implemented)                                                          |
| `terraform-axi state list <module> [--full]`                                                | List resource addresses in a module's state; `--full` enriches each address with its resource type                     |
| `terraform-axi state resource <module> <address> [--full]`                                  | Inspect one state resource with secrets redacted; `--full` disables the default 200-character string limit             |
| `terraform-axi setup [--binary ...] [--wrapper ...] [--module name] [--remove-module name]` | Configure binary, wrapper, and registered modules                                                                      |
| `terraform-axi setup status`                                                                | Inspect current settings and managed hooks                                                                             |
| `terraform-axi setup hooks` / `setup uninstall`                                             | Install or remove terraform-axi-managed user-level SessionStart hooks                                                  |

See [VISION.md](../../VISION.md) for product boundaries and [CONTRIBUTING.md](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md) before contributing.
