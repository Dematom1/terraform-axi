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

See the [README's lint reference](https://github.com/Dematom1/terraform-axi#lint) for behavior and output details.

See [VISION.md](../../VISION.md) for product boundaries and [CONTRIBUTING.md](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md) before contributing.
