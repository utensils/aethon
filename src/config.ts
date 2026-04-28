// Read-only access to ~/.aethon/config.toml. Read-once cache so multiple
// callers on first paint share a single IPC. Defaults returned outside Tauri.

import { invoke } from "@tauri-apps/api/core";

export interface AethonConfig {
  ui: {
    /** Theme id from `[ui] theme = "..."`. Built-ins are
     *  `ember`, `paper`, and `aether`; legacy `signature` maps to
     *  `aether`. Extensions can register additional ids via
     *  `aethon.registerTheme`. */
    theme: string | null;
    fontSize: number | null;
  };
  agent: {
    model: string | null;
  };
}

const DEFAULTS: AethonConfig = {
  ui: { theme: null, fontSize: null },
  agent: { model: null },
};

function hasTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
      "object"
  );
}

let inflight: Promise<AethonConfig> | null = null;

export function getConfig(): Promise<AethonConfig> {
  if (inflight) return inflight;
  if (!hasTauri()) {
    inflight = Promise.resolve(DEFAULTS);
    return inflight;
  }
  inflight = (async () => {
    try {
      const raw = await invoke<unknown>("read_config");
      const obj = raw as Partial<AethonConfig>;
      return {
        ui: {
          theme: normalizeTheme(obj?.ui?.theme),
          fontSize:
            typeof obj?.ui?.fontSize === "number" ? obj.ui.fontSize : null,
        },
        agent: {
          model: typeof obj?.agent?.model === "string" ? obj.agent.model : null,
        },
      };
    } catch (err) {
      console.warn("read_config failed:", err);
      return DEFAULTS;
    }
  })();
  return inflight;
}

function normalizeTheme(t: unknown): string | null {
  return typeof t === "string" && t.length > 0 ? t : null;
}
