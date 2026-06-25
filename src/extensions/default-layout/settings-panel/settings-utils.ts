import { MAX_AGENT_TIMEOUT_SECONDS } from "../../../config";

export function clampTimeoutInput(
  value: string,
  fallback: number | null,
): number | null {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_AGENT_TIMEOUT_SECONDS);
}
