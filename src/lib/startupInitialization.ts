export const INITIALIZATION_CHECK_TIMEOUT_MS = 10_000;

export class InitializationCheckTimeoutError extends Error {
  constructor() {
    super("The application initialization check did not respond in time.");
    this.name = "InitializationCheckTimeoutError";
  }
}

export async function awaitInitializationCheck<T>(
  check: () => Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new InitializationCheckTimeoutError()),
          INITIALIZATION_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
