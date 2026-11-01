---
name: terraform-axi
description: Read-only Terraform and OpenTofu plan and state inspection CLI.
---

# terraform-axi

Use terraform-axi for read-only infrastructure inspection. Never apply or destroy.

<h1 align="center">terraform-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/terraform-axi"><img alt="npm" src="https://img.shields.io/npm/v/terraform-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/terraform-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/terraform-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue?style=flat-square" /></a>
</p>

Read-only Terraform and OpenTofu inspection for agents. Output is compact [TOON](https://toonformat.dev/) and follows [AXI](https://github.com/kunchenguid/axi) principles. CI tests Linux and macOS; Windows is not currently supported.

**Safety:** terraform-axi never applies or destroys. Secrets are always redacted. It never writes state to disk. The scaffold currently wires command stubs; plan, drift, doctor, and state inspection are not implemented yet.

## Install and configure

Requires Node.js 20.19+.

```sh
npm install -g terraform-axi
terraform-axi setup --binary auto --wrapper 'just tf {module}'
terraform-axi setup status
```

The wrapper is optional. Use `{module}` as the module placeholder. Credentials are inherited by Terraform/OpenTofu from the environment; `_FILE` variants and credential commands will be supported by the diagnostic implementation. Never put credentials in arguments or config.

