export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly diagnostics: unknown[] = [],
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

/** A failure whose full report is the output, e.g. a plan with errors or a failed `--expect`. */
export class ReportError extends CliError {
  constructor(readonly report: Record<string, unknown>) {
    super(String(report.status ?? "failed"));
    this.name = "ReportError";
  }
}
