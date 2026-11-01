export type StateResource = { address: string; type: string; mode: string; module: string };
export type StateDetail = {
  address: string;
  type: string;
  provider: string;
  attributes: Record<string, unknown>;
  sensitiveValues: unknown;
};
export type StateModel = {
  resources: StateResource[];
  details: StateDetail[];
  outputs: { name: string; sensitive: boolean }[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseState(json: string): StateModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Malformed Terraform state JSON");
  }
  const root = record(parsed);
  if (!root) throw new Error("Malformed Terraform state JSON");
  const resources: StateResource[] = [];
  const details: StateDetail[] = [];
  const walk = (module: unknown, moduleAddress: string) => {
    const item = record(module);
    if (!item) return;
    if (Array.isArray(item.resources))
      for (const resource of item.resources) {
        const value = record(resource);
        if (!value || typeof value.address !== "string" || typeof value.type !== "string") continue;
        const address = value.address;
        const type = value.type;
        const mode = typeof value.mode === "string" ? value.mode : "managed";
        const instances = Array.isArray(value.instances) ? value.instances : [];
        for (const rawInstance of instances) {
          const instance = record(rawInstance);
          if (!instance) continue;
          const instanceAddress =
            instance.index_key === undefined ? address : `${address}[${JSON.stringify(instance.index_key)}]`;
          resources.push({ address: instanceAddress, type, mode, module: moduleAddress });
          details.push({
            address: instanceAddress,
            type,
            provider: typeof value.provider_name === "string" ? value.provider_name : "",
            attributes: record(instance.attributes) ?? {},
            sensitiveValues: instance.sensitive_values ?? {},
          });
        }
        if (instances.length === 0) resources.push({ address, type, mode, module: moduleAddress });
      }
    if (Array.isArray(item.child_modules))
      for (const child of item.child_modules) {
        const childRecord = record(child);
        if (childRecord && typeof childRecord.address === "string") walk(child, childRecord.address);
      }
  };
  walk(record(root.values)?.root_module, "");
  const outputs = Object.entries(record(root.outputs) ?? {}).map(([name, output]) => ({
    name,
    sensitive: record(output)?.sensitive === true,
  }));
  return { resources, details, outputs };
}
