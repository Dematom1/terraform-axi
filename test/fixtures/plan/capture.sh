#!/bin/sh
# Re-capture the plan -json fixtures in this directory from a real binary.
# Usage: test/fixtures/plan/capture.sh <terraform|tofu binary> <name-prefix>
# Example: test/fixtures/plan/capture.sh terraform terraform-1.15.8
#
# Every module is a throwaway mktemp directory with the default local backend,
# built-in terraform_data resources, and hashicorp/local for the drift case.
# Each command runs under `env -i` with a temporary HOME so no cloud credentials
# or TF_* variables reach the binary. The setup applies only inside those
# throwaway directories to give the plan existing state; nothing else is applied.
set -eu

bin=$1
prefix=$2
out=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
binpath=$(command -v "$bin")

tf() {
  dir=$1
  shift
  env -i PATH="$(dirname "$binpath"):/usr/bin:/bin" HOME="$work/home" "$binpath" -chdir="$dir" "$@"
}

plan() {
  # The product's exact argv. Exit 2 means changes are present.
  dir=$1
  name=$2
  shift 2
  tf "$dir" plan -json -input=false -lock=false -detailed-exitcode "$@" >"$out/$prefix-$name.jsonl" || [ $? -eq 2 ]
}

mkdir -p "$work/home"

# changes: every resource action, each replace reason, and a sensitive output change.
m="$work/changes"
mkdir -p "$m"
cat >"$m/main.tf" <<'EOF'
resource "terraform_data" "keep" { input = "v1" }
resource "terraform_data" "repl" { triggers_replace = "v1" }
resource "terraform_data" "cbd" {
  triggers_replace = "v1"
  lifecycle { create_before_destroy = true }
}
resource "terraform_data" "trigger" { input = "v1" }
resource "terraform_data" "triggered" {
  lifecycle { replace_triggered_by = [terraform_data.trigger] }
}
resource "terraform_data" "gone" {}
resource "terraform_data" "old" {}
resource "terraform_data" "forgotten" {}
output "token" {
  value     = "a"
  sensitive = true
}
EOF
tf "$m" init -input=false >/dev/null
tf "$m" apply -auto-approve -input=false >/dev/null
cat >"$m/main.tf" <<'EOF'
resource "terraform_data" "keep" { input = "v2" }
resource "terraform_data" "repl" { triggers_replace = "v2" }
resource "terraform_data" "cbd" {
  triggers_replace = "v2"
  lifecycle { create_before_destroy = true }
}
resource "terraform_data" "trigger" { input = "v2" }
resource "terraform_data" "triggered" {
  lifecycle { replace_triggered_by = [terraform_data.trigger] }
}
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
  value     = "b"
  sensitive = true
}
EOF
plan "$m" changes

# no-change: an applied module planned again without edits.
m="$work/nochange"
mkdir -p "$m"
echo 'resource "terraform_data" "keep" { input = "v1" }' >"$m/main.tf"
tf "$m" init -input=false >/dev/null
tf "$m" apply -auto-approve -input=false >/dev/null
plan "$m" no-change

# error: a configuration error, so the stream has diagnostics and no change_summary.
m="$work/error"
mkdir -p "$m"
echo 'resource "terraform_data" "bad" { input = terraform_data.missing.id }' >"$m/main.tf"
tf "$m" init -input=false >/dev/null
plan "$m" error || true

# drift: a local_file deleted out of band, planned with -refresh-only.
m="$work/drift"
mkdir -p "$m"
cat >"$m/main.tf" <<'EOF'
terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}
resource "local_file" "drifted" {
  filename = "${path.module}/drifted.txt"
  content  = "v1"
}
EOF
tf "$m" init -input=false >/dev/null
tf "$m" apply -auto-approve -input=false >/dev/null
rm "$m/drifted.txt"
plan "$m" drift -refresh-only

# truncated: the changes stream cut mid-line, as a killed process would leave it.
head -c "$(($(wc -c <"$out/$prefix-changes.jsonl") - 40))" "$out/$prefix-changes.jsonl" >"$out/$prefix-truncated.jsonl"
