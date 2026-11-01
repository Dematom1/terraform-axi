#!/bin/sh
# Re-capture the `show -json` plan document fixture in this directory from a real binary.
# Usage: test/fixtures/plan/capture-show.sh <terraform|tofu binary> <name-prefix>
# Example: test/fixtures/plan/capture-show.sh tofu tofu-1.13.1
#
# The module is a throwaway mktemp directory on the default local backend. Prior state is a
# hand-written terraform.tfstate, so nothing is ever applied. Each command runs under `env -i`
# with a temporary HOME so no cloud credentials or TF_* variables reach the binary. The binary
# plan file lives only inside the throwaway directory and is removed with it.
set -eu

bin=$1
prefix=$2
out=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
binpath=$(command -v "$bin")

tf() {
  env -i PATH="$(dirname "$binpath"):/usr/bin:/bin" HOME="$work/home" "$binpath" -chdir="$work/m" "$@"
}

mkdir -p "$work/home" "$work/m"
cat >"$work/m/main.tf" <<'TF'
resource "terraform_data" "keep" { input = "v2" }
resource "terraform_data" "repl" { triggers_replace = "v2" }
resource "terraform_data" "new" {}
moved {
  from = terraform_data.old
  to   = terraform_data.moved
}
resource "terraform_data" "moved" {}
removed {
  from = terraform_data.forgotten
  lifecycle { destroy = false }
}
import {
  to = terraform_data.imported
  id = "imported-id"
}
resource "terraform_data" "imported" {}
data "terraform_remote_state" "deferred" {
  backend    = "local"
  config     = { path = "unused.tfstate" }
  depends_on = [terraform_data.keep]
}
output "token" {
  value     = "after-SENTINEL"
  sensitive = true
}
TF
cat >"$work/m/terraform.tfstate" <<'STATE'
{"version":4,"terraform_version":"1.0.0","serial":1,"lineage":"00000000-0000-0000-0000-000000000001",
"outputs":{"token":{"value":"before-SENTINEL","type":"string","sensitive":true}},
"resources":[
{"mode":"managed","type":"terraform_data","name":"keep","provider":"provider[\"terraform.io/builtin/terraform\"]","instances":[{"schema_version":0,"attributes":{"id":"keep-id","input":{"value":"v1","type":"string"},"output":{"value":"v1","type":"string"},"triggers_replace":null},"sensitive_attributes":[]}]},
{"mode":"managed","type":"terraform_data","name":"repl","provider":"provider[\"terraform.io/builtin/terraform\"]","instances":[{"schema_version":0,"attributes":{"id":"repl-id","input":null,"output":null,"triggers_replace":{"value":"v1","type":"string"}},"sensitive_attributes":[]}]},
{"mode":"managed","type":"terraform_data","name":"gone","provider":"provider[\"terraform.io/builtin/terraform\"]","instances":[{"schema_version":0,"attributes":{"id":"gone-id","input":null,"output":null,"triggers_replace":null},"sensitive_attributes":[]}]},
{"mode":"managed","type":"terraform_data","name":"old","provider":"provider[\"terraform.io/builtin/terraform\"]","instances":[{"schema_version":0,"attributes":{"id":"old-id","input":null,"output":null,"triggers_replace":null},"sensitive_attributes":[]}]},
{"mode":"managed","type":"terraform_data","name":"forgotten","provider":"provider[\"terraform.io/builtin/terraform\"]","instances":[{"schema_version":0,"attributes":{"id":"forgotten-id","input":null,"output":null,"triggers_replace":null},"sensitive_attributes":[]}]}
]}
STATE
tf init -input=false >/dev/null
tf plan -input=false -lock=false -out="$work/plan.bin" >/dev/null
tf show -json "$work/plan.bin" | sed 's/"timestamp":"[^"]*"/"timestamp":"2026-01-01T00:00:00Z"/' >"$out/$prefix-show.json"
