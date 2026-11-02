// Deadlines and cancellation for the prototype. A wait settles with its work, or with a deadline
// or cancellation error, whichever comes first; what the work does after that is ignored here.

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DeadlineError extends Error {
  constructor(stage: string) {
    super(`prototype deadline exceeded: ${stage}`);
    this.name = "DeadlineError";
  }
}

export class CancelledError extends Error {
  constructor(reason: unknown) {
    super(`prototype cancelled: ${String(reason)}`);
    this.name = "CancelledError";
  }
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CancelledError(signal.reason);
}

/**
 * Settles like `work`, unless `ms` pass first (DeadlineError for `stage`) or `signal` aborts
 * (its reason when that is an Error, else a CancelledError). Without `ms`, only the signal.
 */
export function within<T>(
  stage: string,
  work: Promise<T>,
  ms: number | undefined,
  clock: Clock,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(aborted(signal)));
    const timer =
      ms === undefined
        ? undefined
        : clock.setTimeout(() => finish(() => reject(new DeadlineError(stage))), Math.max(0, ms));
    signal.addEventListener("abort", onAbort);
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
