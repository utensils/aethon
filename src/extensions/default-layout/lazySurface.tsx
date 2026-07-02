/**
 * Lazy registration wrapper for heavy chrome surfaces.
 *
 * The ExtensionRegistry + `<RegistryComponent>` indirection means a
 * registered component's identity is resolved at render time — so a
 * `React.lazy` wrapper registered here splits the surface into its own
 * chunk without touching the renderer or any call site. The Suspense
 * boundary lives INSIDE the registered component, keeping the A2UI
 * renderer fully synchronous, and the wrapper is type-compatible with
 * `A2UIComponentImpl`, so extension overrides via
 * `aethon.registerComponent` keep working exactly as before (they
 * replace the whole wrapper in the components map; bridge-shipped
 * declarative templates still win at resolve time).
 *
 * `preload()` lets App warm the chunks after chrome-ready so the first
 * open of settings/palette/editor pays ~nothing.
 */

import { Suspense, lazy, type ComponentType } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

type SurfaceImpl = ComponentType<BuiltinComponentProps>;

export type LazySurfaceComponent = SurfaceImpl & {
  preload: () => Promise<void>;
};

export function lazySurface(
  name: string,
  load: () => Promise<{ default: SurfaceImpl }>,
): LazySurfaceComponent {
  let loadPromise: Promise<{ default: SurfaceImpl }> | null = null;
  const memoLoad = () => (loadPromise ??= load());
  const Lazy = lazy(memoLoad);
  // Null fallback: every wave-1 surface either fills a flex/grid cell
  // (canvases, panels — the chrome around it doesn't move) or is an
  // overlay (palette, settings), so a one-frame empty state can't shift
  // layout.
  const Wrapper = (props: BuiltinComponentProps) => (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
  Wrapper.displayName = `LazySurface(${name})`;
  const surface = Wrapper as LazySurfaceComponent;
  surface.preload = () =>
    memoLoad().then(
      () => undefined,
      () => undefined,
    );
  return surface;
}
