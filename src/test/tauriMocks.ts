/** Test helpers for stubbing `@tauri-apps/api/core.invoke` and
 *  `@tauri-apps/api/event.listen`. Use from a `beforeEach` in any test that
 *  drives Tauri-aware code:
 *
 *    import { installTauriMocks } from "../test/tauriMocks";
 *
 *    beforeEach(() => {
 *      const harness = installTauriMocks();
 *      // harness.invoke.mockImplementation(...)
 *      // harness.fireEvent("agent-response", JSON.stringify({...}))
 *    });
 *
 *  `installTauriMocks` re-binds the global mocks created in `setup.ts` so the
 *  per-test handlers/captured calls are isolated. The harness exposes the raw
 *  mock plus a `fireEvent(name, payload)` helper that synthesizes the event
 *  shape Tauri's `listen` callback expects. */
import { vi, type Mock } from "vitest";
import { invoke as realInvoke } from "@tauri-apps/api/core";
import { emit as realEmit, listen as realListen } from "@tauri-apps/api/event";

type ListenCallback<T = unknown> = (event: { payload: T }) => void;

export interface TauriMockHarness {
  /** The mocked `invoke`. Cast: `invoke as Mock`. */
  invoke: Mock;
  /** The mocked `listen`. Use `harness.listen.mock.calls` to assert
   *  registrations; prefer `fireEvent` for delivering payloads. */
  listen: Mock;
  /** The mocked `emit`. */
  emit: Mock;
  /** Fire a synthetic event to every handler registered via `listen` for
   *  the given event name. Returns the number of handlers invoked. */
  fireEvent: <T = unknown>(name: string, payload: T) => number;
  /** Map of event name → handler list. Exposed for tests that need to
   *  introspect registrations beyond `listen.mock.calls`. */
  handlers: Map<string, Set<ListenCallback>>;
  /** Reset captured calls + registered handlers. Auto-runs at install
   *  time; call again from a test if you need a clean slate mid-test. */
  reset: () => void;
}

export function installTauriMocks(): TauriMockHarness {
  const invoke = realInvoke as unknown as Mock;
  const listen = realListen as unknown as Mock;
  const emit = realEmit as unknown as Mock;
  const handlers = new Map<string, Set<ListenCallback>>();

  const reset = () => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve(undefined));
    listen.mockReset();
    emit.mockReset();
    emit.mockImplementation(() => Promise.resolve());
    listen.mockImplementation((name: string, cb: ListenCallback) => {
      let bucket = handlers.get(name);
      if (!bucket) {
        bucket = new Set();
        handlers.set(name, bucket);
      }
      bucket.add(cb);
      return Promise.resolve(() => {
        bucket?.delete(cb);
      });
    });
    handlers.clear();
  };

  reset();

  const fireEvent = <T>(name: string, payload: T): number => {
    const bucket = handlers.get(name);
    if (!bucket || bucket.size === 0) return 0;
    for (const cb of bucket) cb({ payload });
    return bucket.size;
  };

  return { invoke, listen, emit, fireEvent, handlers, reset };
}

/** Restore the default no-op behavior. Call from `afterEach` if the harness
 *  was installed in `beforeEach`, so a leaked stub doesn't bleed into the
 *  next test file's first call. */
export function clearTauriMocks(): void {
  vi.restoreAllMocks();
  // Re-install the default no-ops so other mocks layered on top of the
  // setup mock module don't crash when subsequent tests import `invoke`.
  (realInvoke as unknown as Mock).mockImplementation(() =>
    Promise.resolve(undefined),
  );
  (realListen as unknown as Mock).mockImplementation(() =>
    Promise.resolve(() => {}),
  );
  (realEmit as unknown as Mock).mockImplementation(() => Promise.resolve());
}
