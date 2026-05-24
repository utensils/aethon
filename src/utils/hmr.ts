export function shouldReloadForHmrPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;
  const updates = (payload as { updates?: unknown }).updates;
  if (!Array.isArray(updates)) return true;
  if (updates.length === 0) return false;
  return updates.some((update) => {
    if (!update || typeof update !== "object") return true;
    return (update as { type?: unknown }).type !== "css-update";
  });
}
