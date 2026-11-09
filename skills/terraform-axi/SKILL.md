---
name: terraform-axi
description: Read-only Terraform and OpenTofu CLI; see the README command reference for current behavior and options.
---

# terraform-axi

Use terraform-axi for read-only infrastructure inspection. Never apply or destroy.

See the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for the full command list.

## Commands

Use the [README command reference](https://github.com/Dematom1/terraform-axi#commands) for supported commands, defaults, safety behavior, and examples. `terraform-axi <command> --help` shows command-specific options.

### Lint

`terraform-axi lint <module>` runs `fmt -check -no-color` (never rewrites files), then `validate -json -no-color` only when the module's `.terraform` directory exists (or `TF_DATA_DIR`, resolved relative to the module). An absent data directory reports validation as **skipped**, not passed. Lint never runs `init`, installs providers, or writes state. A data directory is only an initialization prerequisite: missing providers or modules still fail validation. Configured wrappers must target the same local module directory; `--binary terraform|tofu` bypasses the wrapper.

If `tflint` is on PATH, lint runs `tflint --format=json` in the module directory, without initialization or plugin installation; otherwise it reports **skipped**. Installed tflint failures are errors, not skips. Each subprocess has a 60-second deadline (binary selection probes retain their 2-second deadlines). Module contents are not changed by lint's commands; configured wrappers and tflint plugins are trusted executable code.

Output includes each check's status, a total finding `count`, and `findings` with `file`, `line`, `rule`, `severity`, and `message`. Locations unavailable from a tool are `null` (fmt lists files, not lines). An error finding exits 1; warnings alone exit 0. Skips remain explicit even when the exit code is 0, so a successful lint does not imply every check ran. Invalid arguments exit 2.

See [VISION.md](../../VISION.md) for product boundaries and [CONTRIBUTING.md](https://github.com/Dematom1/terraform-axi/blob/main/CONTRIBUTING.md) before contributing.
