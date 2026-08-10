// One error shape for the whole CLI: a message (the cause) plus at most one hint (the next step).
// Deep code throws; src/cli/render.ts prints, exactly once.

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  conflict: 4,
  rpc: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: ExitCode;

  constructor(message: string, opts: { hint?: string; exitCode?: ExitCode; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? EXIT.error;
  }
}

export function fail(message: string, opts?: ConstructorParameters<typeof CliError>[1]): never {
  throw new CliError(message, opts);
}
