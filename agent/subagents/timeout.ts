import { logger } from "../logger";

export const ABORT_CLEANUP_GRACE_MS = 2_000;

export async function waitForAbortCleanup(
  abortPromise: Promise<void>,
  subagentName: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(
      () => resolve("timeout"),
      ABORT_CLEANUP_GRACE_MS,
    );
  });
  const result = await Promise.race([
    abortPromise.then(() => "settled" as const),
    timeoutPromise,
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === "timeout") {
    logger
      .scope("subagent")
      .warn(
        `abort did not settle within ${ABORT_CLEANUP_GRACE_MS}ms for "${subagentName}"; disposing session anyway`,
      );
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
