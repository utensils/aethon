// Cached prediction of what the NEXT cold boot will look like, so App can
// paint the built-in workstation immediately instead of holding the
// StartupCurtain until the agent bridge finishes booting. Written from the
// bridge `ready` handler with the facts about THIS run; read synchronously
// at App mount. A run that used any custom extension chrome (an extension
// layout, extension frontend modules, or an active extension theme) records
// that fact so the next boot keeps today's curtain and never flashes the
// wrong layout/theme. Every read/write is best-effort — localStorage can
// throw (private mode, quota, disabled storage) and a hiccup here must never
// affect boot correctness.

const STORAGE_KEY = "aethon-chrome-boot";

export interface ChromeBootSnapshot {
  /** Previous run applied an extension-provided layout (not the built-in
   *  boot layout). Built-in chrome would paint the wrong grid. */
  customLayout: boolean;
  /** Previous run registered extension frontend modules (custom React
   *  components in the ExtensionRegistry). */
  frontendModules: boolean;
  /** Previous run's active theme was an extension theme. Conservative v1:
   *  extension theme CSS is NOT re-injected at boot (fragile to capture),
   *  so an active extension theme forces the curtain to avoid a first-paint
   *  theme flash. Built-in themes are applied before paint by the boot
   *  config pass (`bootConfigReady`), so they never flash. */
  extTheme: boolean;
}

// Test seam: node-env unit tests have no `localStorage`. `undefined` means
// "resolve the real one"; an explicit value (including `null`) overrides.
let storageOverride: Storage | null | undefined;

function resolveStorage(): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export interface WriteChromeBootSnapshotOptions {
  /** `[boot] optimistic_chrome` kill-switch. `false` clears any stored
   *  snapshot so the next boot takes the curtain path unconditionally. */
  optimisticChrome: boolean;
}

/** Persist the boot snapshot for the next launch. When the kill-switch is
 *  off, remove any prior snapshot so a stale record can't keep optimism on. */
export function writeChromeBootSnapshot(
  snapshot: ChromeBootSnapshot,
  { optimisticChrome }: WriteChromeBootSnapshotOptions,
): void {
  const store = resolveStorage();
  if (!store) return;
  try {
    if (!optimisticChrome) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    store.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* best-effort */
  }
}

/** Read the last persisted snapshot. Missing or malformed → null. */
export function readChromeBootSnapshot(): ChromeBootSnapshot | null {
  const store = resolveStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.customLayout !== "boolean" ||
      typeof rec.frontendModules !== "boolean" ||
      typeof rec.extTheme !== "boolean"
    ) {
      return null;
    }
    return {
      customLayout: rec.customLayout,
      frontendModules: rec.frontendModules,
      extTheme: rec.extTheme,
    };
  } catch {
    return null;
  }
}

export function clearChromeBootSnapshot(): void {
  const store = resolveStorage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/** True iff the previous run recorded a built-ins-only session — no
 *  extension layout, no extension frontend modules, no active extension
 *  theme. Never throws (missing/malformed snapshot → false → curtain). */
export function shouldPaintChromeOptimistically(): boolean {
  const snap = readChromeBootSnapshot();
  if (!snap) return false;
  return !snap.customLayout && !snap.frontendModules && !snap.extTheme;
}

/** Test-only: inject a storage backend (node env has no localStorage). */
export const __testing = {
  setStorage(store: Storage | null): void {
    storageOverride = store;
  },
  reset(): void {
    storageOverride = undefined;
  },
  STORAGE_KEY,
};
