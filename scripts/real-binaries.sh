#!/bin/sh
# Run the test suite against real Terraform 1.15.8 and OpenTofu 1.13.1, the versions CI pins.
# Both release zips are downloaded from their official URLs into a temporary directory,
# verified against the SHA256 sums pinned below, and put first on PATH for this run only.
# Cloud credentials and TF_* variables are removed so no test can reach real infrastructure.
# Usage: npm run test:real
set -eu

terraform_version=1.15.8
tofu_version=1.13.1

case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) echo "unsupported OS: $(uname -s)" >&2 && exit 1 ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) echo "unsupported architecture: $(uname -m)" >&2 && exit 1 ;;
esac

case "$os-$arch" in
darwin-amd64)
  terraform_sha=e2e812e783771159bf758fd4e55d6dc9bb08f63e2af2c63d212721807a02c5dc
  tofu_sha=d44ab59ec53fb18e900f4ae3fc8b72e042c9e03ca957860edbaac04e4427218d
  ;;
darwin-arm64)
  terraform_sha=f210110c5698b94d803a7a63cdb0251b5455c150841478808e2bbb343f95ed68
  tofu_sha=81aebe6453223bcb3ce3c28424b36d009ebfddd3ad65ad1ec3eed0d0d574a77b
  ;;
linux-amd64)
  terraform_sha=d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d
  tofu_sha=8ccbc6f8ee21d2827715f3c6e08a9b3e0209b1e62057c05067ef117e047c1a80
  ;;
linux-arm64)
  terraform_sha=8891e9dcedc9e3b8950bc6af9d4d8af1f4cfade3062f53b9dc403a89f6ce8c9c
  tofu_sha=b9614df40575cc3fc10a8a25025b7245d961da279f715ea3efff4ddae8e6938a
  ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

fetch() {
  url=$1
  want=$2
  zip="$work/$(basename "$url")"
  curl -fsSL --retry 3 -o "$zip" "$url"
  got=$(sha256 "$zip")
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $url: expected $want, got $got" >&2
    exit 1
  fi
  unzip -q -o "$zip" -d "$work/bin"
}

fetch "https://releases.hashicorp.com/terraform/$terraform_version/terraform_${terraform_version}_${os}_${arch}.zip" "$terraform_sha"
fetch "https://github.com/opentofu/opentofu/releases/download/v$tofu_version/tofu_${tofu_version}_${os}_${arch}.zip" "$tofu_sha"

for name in $(env | grep -E '^(AWS|B2|ARM|GOOGLE|TF)_' | cut -d= -f1); do unset "$name"; done
PATH="$work/bin:$PATH"
export PATH
export TF_AXI_REQUIRE_REAL_BINARIES=1
terraform version
tofu version
npm test
