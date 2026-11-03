# Contributing

Use conventional commits. Node.js 20.19+ is required. Run `npm ci`, `npm test`, `npm run lint`, `npm run format:check`, and `npm run check:skill` before submitting changes.

terraform-axi is read-only: do not add apply or destroy behavior, persist state, or use real cloud credentials in tests. Use fixture plans/JSON and throwaway local-backend modules only. Never run tests with inherited cloud credentials; clear `AWS_*`, `B2_*`, and other cloud-provider variables.

For release-please workflow exemptions, configure the repository variable `RELEASE_APP_BOT_LOGIN` with the GitHub App bot login. Set it through Terraform; if unset, release PRs run the normal generated-file and no-mistakes checks.

See [the new AXI tool checklist](docs/new-axi-tool-checklist.md) for structural and validation requirements.

## Real Terraform and OpenTofu tests

`npm test` skips the real-binary tests when `terraform` or `tofu` is not on `PATH`. Run `npm run test:real` to run the full suite against real binaries. The script downloads Terraform 1.15.8 and OpenTofu 1.13.1 from their official release URLs into a temporary directory and verifies them against pinned SHA256 sums. It then runs `npm test` with both binaries required and with cloud credentials and `TF_*` variables removed. It supports macOS and Linux on arm64 and amd64, and needs `curl` and `unzip`.

## Dependency update pilot

Only this repository adopts the shared Renovate preset and dependency verification workflow from `Dematom1/oss-workflows`. Both references use the same immutable commit. Renovate manages npm dependencies only: action updates require a normal no-mistakes PR.

Non-major updates form one weekly batch after a three-day release delay. Majors remain separate and require review. Platform automerge requires passing required checks and the repository's Terraform-managed `allow_auto_merge` setting.

For `renovate[bot]` PRs, `PR must be raised via no-mistakes` rejects changes outside `package.json`, `package-lock.json`, and `renovate.json`, including renamed source files. It waits up to 45 minutes for a successful dependency verification run on the exact head SHA. A rebase or automatic split needs a new successful run. Other PRs still require the existing signed no-mistakes attestation.

The shared workflow installs dependencies, builds, runs the full tests, and runs `npm run test:real` without cloud credentials. It checks npm signatures and provenance, posts a bounded dependency diff, and diagnoses failed batches with bounded bisection. `axi-verify` is explicitly skipped until that tool ships. Bisection does not turn a failed verification green.

Run the gate's local changed-file and same-SHA fixtures with `npm exec -- vitest run test/dependency-verification.test.mjs`. They also run in `npm test`. Keep the pilot scoped to this repository until its first real Renovate PR has been reviewed.
