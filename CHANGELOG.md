# Changelog

## [0.1.3](https://github.com/Dematom1/terraform-axi/compare/terraform-axi-v0.1.2...terraform-axi-v0.1.3) (2026-11-07)


### Bug Fixes

* **runner:** kill subprocess groups at deadline ([#27](https://github.com/Dematom1/terraform-axi/issues/27)) ([7400f09](https://github.com/Dematom1/terraform-axi/commit/7400f09e15c6d7e4c0843409c3c9afa9b39d4952))

## [0.1.2](https://github.com/Dematom1/terraform-axi/compare/terraform-axi-v0.1.1...terraform-axi-v0.1.2) (2026-11-04)


### Bug Fixes

* **cli:** harden setup hooks and stop invocation telemetry ([#23](https://github.com/Dematom1/terraform-axi/issues/23)) ([6ed9f50](https://github.com/Dematom1/terraform-axi/commit/6ed9f50ec619df1aa5b3cd999c5df32afbfb0e11))

## [0.1.1](https://github.com/Dematom1/terraform-axi/compare/terraform-axi-v0.1.0...terraform-axi-v0.1.1) (2026-11-03)


### Features

* **cli:** add read-only Terraform drift detection ([#8](https://github.com/Dematom1/terraform-axi/issues/8)) ([5c29738](https://github.com/Dematom1/terraform-axi/commit/5c29738a5ad48bfc5f24dc3c9a2c609ca6f3b2f5))
* **cli:** add read-only Terraform lint command ([#14](https://github.com/Dematom1/terraform-axi/issues/14)) ([292fad5](https://github.com/Dematom1/terraform-axi/commit/292fad5159d49b6249f3f8e468d50200f6ec58c1))
* **cli:** remember commands across sessions ([#10](https://github.com/Dematom1/terraform-axi/issues/10)) ([8024842](https://github.com/Dematom1/terraform-axi/commit/80248425af0cc6b9c076994699cf62c146fd83dc))
* **doctor:** add read-only backend diagnostics ([#11](https://github.com/Dematom1/terraform-axi/issues/11)) ([6f412a0](https://github.com/Dematom1/terraform-axi/commit/6f412a0fb2ee70ab24bd03a5515271e5c47ae328))
* **doctor:** explain backend credentials and common errors ([#5](https://github.com/Dematom1/terraform-axi/issues/5)) ([e60cd14](https://github.com/Dematom1/terraform-axi/commit/e60cd145886123a2a83a76fb2bf45f7936a485d3))
* **plan:** add read-only Terraform plan summaries ([#9](https://github.com/Dematom1/terraform-axi/issues/9)) ([7a47005](https://github.com/Dematom1/terraform-axi/commit/7a47005da3ebf9df381c0a67d566b743dbf8d9ce))
* **plan:** parse and assess Terraform plan streams ([#6](https://github.com/Dematom1/terraform-axi/issues/6)) ([0fd00fe](https://github.com/Dematom1/terraform-axi/commit/0fd00fe5ff7430d194010568bbdb9781ee0797c6))
* **state:** add read-only state inspection commands ([#7](https://github.com/Dematom1/terraform-axi/issues/7)) ([e069c3a](https://github.com/Dematom1/terraform-axi/commit/e069c3a269cd1850ae2d155bb3993410946955e2))
* **state:** parse and redact Terraform state ([#2](https://github.com/Dematom1/terraform-axi/issues/2)) ([92bc1f5](https://github.com/Dematom1/terraform-axi/commit/92bc1f5f4f093218f5845c7a91b4907d38c0c39e))
* **terraform-axi:** add read-only Terraform CLI scaffold ([#1](https://github.com/Dematom1/terraform-axi/issues/1)) ([3fc4365](https://github.com/Dematom1/terraform-axi/commit/3fc4365fa5bfe76277063fa4f7b7ddeca76d362d))
* **terraform-axi:** add validated config and safe Terraform runner ([#4](https://github.com/Dematom1/terraform-axi/issues/4)) ([4b25e6c](https://github.com/Dematom1/terraform-axi/commit/4b25e6c36e9c79b88904285d7941e6b92bdee199))


### Bug Fixes

* allow manual release publishing ([#13](https://github.com/Dematom1/terraform-axi/issues/13)) ([8ff9211](https://github.com/Dematom1/terraform-axi/commit/8ff92118d491da1a6c4a2da6550778dfd0dfc83a))
* **ci:** accept verified release commits and ignore generated changelog ([#19](https://github.com/Dematom1/terraform-axi/issues/19)) ([e84ff92](https://github.com/Dematom1/terraform-axi/commit/e84ff92ca2ce9d7262e10f53cf977136fa3fcb81))
* **plan:** prevent sensitive diagnostics leaks ([#20](https://github.com/Dematom1/terraform-axi/issues/20)) ([3eb86aa](https://github.com/Dematom1/terraform-axi/commit/3eb86aa229ce0299416cd5a55ef5652e53697304))
* **setup:** report hook and config failures truthfully ([#12](https://github.com/Dematom1/terraform-axi/issues/12)) ([d2181fd](https://github.com/Dematom1/terraform-axi/commit/d2181fddbf10f66beab37ad00475d8b934d4a3d5))
