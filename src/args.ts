import { UsageError } from "./errors.js";

export type Option = { name: string; repeatable?: boolean; boolean?: boolean; values?: readonly string[] };
export function parseArgs(
  argv: string[],
  options: readonly Option[],
): { command?: string; values: Record<string, string[]>; positional: string[] } {
  const specs = new Map(options.map((option) => [option.name, option]));
  const values: Record<string, string[]> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = equal < 0 ? arg : arg.slice(0, equal);
      const spec = specs.get(name);
      if (!spec) throw new UsageError(`unknown flag: ${name}; valid flags: ${[...specs.keys(), "--help"].join(", ")}`);
      if (spec.boolean) {
        if (equal >= 0) throw new UsageError(`invalid value for ${name}`);
        const prior = values[name] ?? [];
        if (prior.length && !spec.repeatable) throw new UsageError(`duplicate flag: ${name}`);
        values[name] = [...prior, "true"];
        continue;
      }
      const value = equal < 0 ? argv[++i] : arg.slice(equal + 1);
      if (value === undefined || value === "" || (equal < 0 && value.startsWith("--")))
        throw new UsageError(`missing or invalid value for ${name}`);
      if (spec.values && !spec.values.includes(value)) throw new UsageError(`invalid value for ${name}: ${value}`);
      const prior = values[name] ?? [];
      if (prior.length && !spec.repeatable) throw new UsageError(`duplicate flag: ${name}`);
      values[name] = [...prior, value];
    } else if (arg.startsWith("-"))
      throw new UsageError(`unknown flag: ${arg}; valid flags: ${[...specs.keys(), "--help"].join(", ")}`);
    else if (command === undefined) command = arg;
    else positional.push(arg);
  }
  return { ...(command === undefined ? {} : { command }), values, positional };
}

export const shellWord = (word: string): string =>
  /^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
export const commandLine = (args: string[]): string => ["terraform-axi", ...args.map(shellWord)].join(" ");
