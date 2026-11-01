# Plan event captures

`terraform-1.15.8.jsonl` was captured from Terraform v1.15.8 with a local, throwaway directory containing a built-in `terraform_data` resource:

```sh
d=$(mktemp -d)
printf 'terraform {\n  required_version = ">= 1.15.8"\n}\nresource "terraform_data" "sample" { input = "captured" }\n' > "$d/main.tf"
terraform -chdir="$d" plan -json -input=false -lock=false > terraform-1.15.8.jsonl
rm -rf "$d"
```

The capture contains no state and uses no cloud credentials. OpenTofu was not installed when this fixture was captured; its capture remains outstanding.

Terraform's summary uses `remove` for planned destroys. A replacement is counted as both an add and a destroy, matching Terraform's summary.
