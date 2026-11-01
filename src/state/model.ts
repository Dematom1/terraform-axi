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
        resources.push({ address, type, mode, module: moduleAddress });
        const instance = record(value.instances instanceof Array ? value.instances[0] : undefined);
        const attributes = record(instance?.attributes) ?? {};
        details.push({
          address,
          type,
          provider: typeof value.provider_name === "string" ? value.provider_name : "",
          attributes,
          sensitiveValues: instance?.sensitive_values ?? {},
        });
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
