export function isGitIndexLockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("git index locked") || message.includes("index.lock");
}
