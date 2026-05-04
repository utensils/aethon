/** Recompute the global model picker's `active` flag against `model`.
 *  Called whenever the active tab changes (switch / new / close) so the
 *  sidebar highlight tracks the active session's chosen model. Returns
 *  a new sidebar object — caller is responsible for splatting into state.
 *
 *  Pure function: no React, no refs. Imported directly by hooks/handlers
 *  that need it rather than plumbed through context.
 */
export function recomputeModelPicker(
  sidebar: Record<string, unknown> | undefined,
  model: string,
): Record<string, unknown> {
  const items = (
    (sidebar?.models as { id: string; label: string }[] | undefined) ?? []
  ).map((m) => ({ id: m.id, label: m.label, active: m.id === model }));
  return { ...(sidebar ?? {}), models: items };
}
