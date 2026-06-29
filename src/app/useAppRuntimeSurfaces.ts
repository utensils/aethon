import {
  useFrontendStateMirror,
  type UseFrontendStateMirrorContext,
} from "../hooks/useFrontendStateMirror";
import {
  useOsEdges,
  type UseOsEdgesContext,
} from "../hooks/useOsEdges";
import {
  usePersistEditorTabs,
  type UsePersistEditorTabsContext,
} from "../hooks/usePersistEditorTabs";
import { useTraySessionsSync } from "../hooks/traySessions";
import {
  useWindowApi,
  type UseWindowApiContext,
} from "../runtime/windowApi";

export type UseAppRuntimeSurfacesContext = UseWindowApiContext &
  UseFrontendStateMirrorContext &
  UsePersistEditorTabsContext &
  UseOsEdgesContext;

/**
 * Runtime surfaces mounted by the app shell after the core chat/project
 * actions exist:
 *
 * - `window.aethon` API and debug hooks
 * - frontend-state mirror back to the bridge
 * - editor-tab persistence
 * - OS-edge listeners that live outside the bridge JSON stream
 *
 * Keeping these together gives `App.tsx` one named boundary for the
 * external runtime wiring while preserving each underlying hook's
 * focused ownership.
 */
export function useAppRuntimeSurfaces(
  ctx: UseAppRuntimeSurfacesContext,
): void {
  useWindowApi(ctx);
  useFrontendStateMirror(ctx);
  usePersistEditorTabs(ctx);
  useTraySessionsSync(ctx.state);
  useOsEdges(ctx);
}
