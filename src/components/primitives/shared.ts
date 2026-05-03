/**
 * Shared types and helpers for built-in A2UI primitives.
 *
 * Lives outside any single family file because `ComponentProps` is the
 * function-arg shape every primitive uses, and `resolvedName` spans
 * multiple families (controls + form). Keeping them here lets each
 * family file declare a single internal sibling import instead of
 * pulling from the parent barrel.
 */

import type { A2UIComponent, StringValue } from "../../types/a2ui";
import { resolveString } from "../../utils/dataBinding";

export interface ComponentProps {
  component: A2UIComponent;
  state: Record<string, unknown>;
  onEvent: (eventType: string, data?: unknown) => void;
  renderChildren?: () => React.ReactNode;
}

export function resolvedName(
  value: StringValue | undefined,
  state: Record<string, unknown>,
): string | undefined {
  if (!value) return undefined;
  const resolved = resolveString(value, state).trim();
  return resolved || undefined;
}
