export function safeUnlisten(unlisten: () => unknown): void {
  try {
    const result = unlisten();
    if (result instanceof Promise) {
      void result.catch(() => {
        // The webview may already have dropped listener ids during reload.
      });
    }
  } catch {
    // Listener teardown is best-effort during reload and shutdown.
  }
}
