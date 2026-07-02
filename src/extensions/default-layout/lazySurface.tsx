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

/** During the boot window, a rendered lazy surface must not start its
 *  import immediately: the workstation layout mounts hidden cells
 *  (editor-canvas, terminal-panel, …) with `display: none` at first
 *  chrome render, and an eager trigger would pull monaco/xterm right
 *  back into the boot sequence, competing with first paint. Loads
 *  requested before the latch releases are queued behind an idle
 *  callback; `releaseLazySurfaceBootDeferral()` (App, at chrome-ready)
 *  drops the latch so every later open loads immediately. */
let bootDeferralActive = true;

export function releaseLazySurfaceBootDeferral(): void {
  bootDeferralActive = false;
}

/** Test-only. */
export function resetLazySurfaceBootDeferralForTest(): void {
  bootDeferralActive = true;
}

const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 3_000 })
    : (cb) => setTimeout(cb, 1_500);

export function lazySurface(
  name: string,
  load: () => Promise<{ default: SurfaceImpl }>,
): LazySurfaceComponent {
  let loadPromise: Promise<{ default: SurfaceImpl }> | null = null;
  const memoLoad = () =>
    (loadPromise ??= bootDeferralActive
      ? new Promise<{ default: SurfaceImpl }>((resolve, reject) => {
          scheduleIdle(() => load().then(resolve, reject));
        })
      : load());
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
  // preload always loads NOW: it runs from App's post-chrome-ready idle
  // callback, after the boot latch has been released.
  surface.preload = () =>
    (loadPromise ??= load()).then(
      () => undefined,
      () => undefined,
    );
  return surface;
}
