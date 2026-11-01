# VISION

terraform-axi gives agents a compact, dependable view of Terraform and OpenTofu infrastructure without crossing into infrastructure mutation.

- Read-only forever, unless the captain explicitly changes that boundary; this tool never applies or destroys.
- Secrets are always redacted, including from state inspection, logs, errors, and hints.
- Terraform and OpenTofu are peers: support both and make differences visible rather than silently changing behavior.
- Respect the operator's configured wrapper command; do not assume the raw executable is the only safe entry point.
- Show concise, truthful status, explicit unknown/unavailable states, useful risk summaries, and copyable next steps.
- Never persist Terraform state or plan secrets as a side effect; use fixtures and throwaway local backends in tests.
