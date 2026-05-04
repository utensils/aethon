/** Vitest setup: registers a default invoke + listen mock for `@tauri-apps/api`
 *  so any test that imports App-tier code (where these modules are statically
 *  imported) doesn't blow up trying to call the real Tauri runtime under node /
 *  jsdom. Tests that need to assert on invoke calls override this per-test via
 *  `installTauriMocks()` from `./tauriMocks`.
 *
 *  Defaults: `invoke()` returns undefined (treated as a successful no-op),
 *  `listen()` returns a no-op unlisten. This matches the shape every consumer
 *  expects without coupling the setup to any one event/command. */
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
