# Contributing

Use conventional commits. Node.js 20.19+ is required. Run `npm ci`, `npm test`, `npm run lint`, `npm run format:check`, and `npm run check:skill` before submitting changes.

terraform-axi is read-only: do not add apply or destroy behavior, persist state, or use real cloud credentials in tests. Use fixture plans/JSON and throwaway local-backend modules only. Never run tests with inherited cloud credentials; clear `AWS_*`, `B2_*`, and other cloud-provider variables.

For release-please workflow exemptions, configure the repository variable `RELEASE_APP_BOT_LOGIN` with the GitHub App bot login. Set it through Terraform; if unset, release PRs run the normal generated-file and no-mistakes checks.

See [the new AXI tool checklist](docs/new-axi-tool-checklist.md) for structural and validation requirements.
