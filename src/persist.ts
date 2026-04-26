// Disk persistence for Aethon state. Writes JSON files under
// `~/.aethon/<name>` via Tauri commands. Falls back to an in-memory
// no-op when running outside Tauri (e.g. unit tests, plain browser).
//
// One-time migration: if the disk file is empty, fall back to localStorage
// for the same key so users upgrading from the localStorage-only build
// keep their chat history.

import { invoke } from "@tauri-apps/api/core";

function hasTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
      "object"
  );
}

export async function readState(name: string): Promise<string> {
  if (!hasTauri()) return "";
  try {
    return await invoke<string>("read_state", { name });
  } catch (err) {
    console.warn(`read_state(${name}) failed:`, err);
    return "";
  }
}

// Returns true on a confirmed disk write. Returns false (and logs) when
// running outside Tauri or when the Tauri command rejects — callers that
// need to know whether the write actually landed (e.g. legacy-key
// migration) must check the boolean.
export async function writeState(name: string, content: string): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    await invoke<void>("write_state", { name, content });
    return true;
  } catch (err) {
    console.warn(`write_state(${name}) failed:`, err);
    return false;
  }
}

// Read disk first; if empty and a legacy localStorage key has data, migrate
// it to disk and return the migrated content. Returns empty string when
// neither store has data.
export async function readStateWithLocalStorageFallback(
  name: string,
  legacyLocalStorageKey: string,
): Promise<string> {
  const disk = await readState(name);
  if (disk) return disk;

  try {
    const legacy = window.localStorage.getItem(legacyLocalStorageKey);
    if (legacy) {
      const wrote = await writeState(name, legacy);
      // Only drop the legacy copy once the disk write has been confirmed —
      // otherwise a permission/HOME/disk-full failure would silently delete
      // the user's only persisted copy of state.
      if (wrote) {
        window.localStorage.removeItem(legacyLocalStorageKey);
      }
      return legacy;
    }
  } catch {
    /* localStorage may be denied — ignore */
  }
  return "";
}
