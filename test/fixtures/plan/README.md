# Plan event captures

Real `plan -json` streams from Terraform 1.15.8 and OpenTofu 1.13.1 (official release binaries, darwin_arm64). Re-capture them with:

```sh
test/fixtures/plan/capture.sh terraform terraform-1.15.8
test/fixtures/plan/capture.sh tofu tofu-1.13.1
```

The script builds throwaway `mktemp` modules on the default local backend and runs every command under `env -i` with a temporary `HOME`, so no cloud credentials or `TF_*` variables reach the binary. To give a plan existing state, the script applies inside those throwaway directories only. The plan command is the product's exact argv: `plan -json -input=false -lock=false -detailed-exitcode`. No plan file is written. No plan file is written.

| File suffix  | Module                                                                                                                                                                                     | Covers                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-changes`   | `terraform_data` resources edited after apply, plus `moved`, `removed` (`destroy = false`), `import`, a deferred `terraform_remote_state` read, and a sensitive output whose value changes | every action (create, update, delete, replace in both orders, read, move, import, forget), replace reasons, Terraform's `action_invocation` and OpenTofu's `forget` summary keys, a changed sensitive output |
| `-no-change` | an applied module planned again                                                                                                                                                            | no changes, zero counts                                                                                                                                                                                      |
| `-error`     | a reference to an undeclared resource                                                                                                                                                      | an error-only stream with no `change_summary`                                                                                                                                                                |
| `-drift`     | a `hashicorp/local` 2.5.2 `local_file` deleted out of band, planned with `-refresh-only`                                                                                                   | `resource_drift` while `change_summary` stays 0/0/0                                                                                                                                                          |
| `-truncated` | the `-changes` stream with its last 40 bytes cut                                                                                                                                           | a truncated final line                                                                                                                                                                                       |

Facts these captures pin:

- Streaming events carry a singular `change.action` and `change.reason`. The plural `actions` array belongs to `show -json` documents.
- `remove` in a stream means forget (stop managing, do not destroy). Neither binary counts it in the summary's `remove` (destroy) count.
- A replace counts toward both add and destroy, matching Terraform's own "N to add, N to destroy" summary.

## `show -json` documents

`*-show.json` are `show -json <planfile>` documents for `plan --plan-json`. Re-capture them with:

```sh
test/fixtures/plan/capture-show.sh terraform terraform-1.15.8
test/fixtures/plan/capture-show.sh tofu tofu-1.13.1
```

The script writes the prior state by hand instead of applying, plans once with `-out` inside a throwaway `mktemp` directory, and deletes that directory with the plan file. The `SENTINEL` output values let tests assert that sensitive values never reach output. Facts these captures pin:

- An import-only resource is `actions: ["no-op"]` with `change.importing`, and a move-only resource is `no-op` with `previous_address`.
- Replace reasons are spelled `replace_because_cannot_update` (the stream says `cannot_update`).
- A plan with no resource changes omits `resource_changes` entirely.

`risk-flags-show.json` is hand-written: it covers IAM, secret, destroy, and replace flags on provider types the captures cannot create, plus an unrecognized action.
