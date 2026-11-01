export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hint(command: string): string {
  return `Run ${quote(command)} for help`;
}
