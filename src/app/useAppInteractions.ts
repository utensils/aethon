import {
  useKeyboardShortcuts,
  type UseKeyboardShortcutsContext,
} from "../hooks/useKeyboardShortcuts";
import { useAppEventRouting } from "../hooks/useAppEventRouting";
import type { EventRouteContext } from "../eventRoutes";

export type AppEventHandler = (
  component: { id: string; type?: string },
  eventType: string,
  data?: unknown,
) => Promise<boolean>;

export type UseAppInteractionsContext = EventRouteContext &
  UseKeyboardShortcutsContext;

/**
 * Installs the app's two interaction entrypoints:
 *
 * - document-level keyboard shortcuts
 * - A2UI event routing for rendered layout components
 *
 * `AppRoot` only needs the returned `onEvent` handler; keeping shortcut
 * subscription beside event routing makes the app shell's interaction
 * boundary explicit.
 */
export function useAppInteractions(
  ctx: UseAppInteractionsContext,
): AppEventHandler {
  useKeyboardShortcuts(ctx);
  return useAppEventRouting(ctx);
}
