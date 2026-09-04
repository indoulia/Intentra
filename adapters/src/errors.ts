/**
 * The failures an operation handler reports, as types rather than as strings.
 *
 * The distinction that matters is between *absent* and *unreachable*. A pull request that
 * has been deleted and a pull-request host that will not answer produce the same silence, and
 * treating them the same is how an idempotency ledger becomes a cache: absent invalidates the
 * record and proceeds, unreachable does nothing at all. So a handler says which it saw, and
 * anything it does not classify is treated as unreachable — the branch that performs no work.
 */

/** Registration was refused. Thrown at registration time, never during a call. */
export class DescriptorError extends Error {
  constructor(readonly adapter: string, readonly op: string, message: string) {
    super(`${adapter}.${op}: ${message}`);
    this.name = 'DescriptorError';
  }
}

/** The resource an operation names does not exist. A fact, established by looking. */
export class ResourceAbsentError extends Error {
  constructor(readonly resource: string, message: string) {
    super(message);
    this.name = 'ResourceAbsentError';
  }
}

/** The resource could not be reached, so whether it exists is unknown. */
export class ResourceUnreachableError extends Error {
  constructor(readonly resource: string, message: string) {
    super(message);
    this.name = 'ResourceUnreachableError';
  }
}

/** The system an operation needs exists on this host but is not configured for use. */
export class NotConfiguredError extends Error {
  constructor(readonly system: string, message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export function isAbsent(error: unknown): error is ResourceAbsentError {
  return error instanceof ResourceAbsentError;
}

export function isUnreachable(error: unknown): error is ResourceUnreachableError {
  return error instanceof ResourceUnreachableError;
}

export function isNotConfigured(error: unknown): error is NotConfiguredError {
  return error instanceof NotConfiguredError;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
