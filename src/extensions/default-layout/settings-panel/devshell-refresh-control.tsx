import { refreshDevshell, type DevshellEntry } from "../../../hooks/useDevshell";
import { resolveDevshellSlice } from "./devshell-state";

/** Reads the current devshell badge state out of the central store and
 *  renders a "Refresh now" button + status string. The button calls
 *  `devshell_refresh`; status updates flow back through the Tauri
 *  events and the `useDevshell` hook. */
export function DevshellRefreshControl({ state }: { state: unknown }) {
  const devshell = resolveDevshellSlice(state);
  const root = devshell?.activeRoot ?? null;
  const entry: DevshellEntry | undefined =
    root && devshell?.entries ? devshell.entries[root] : undefined;
  const status = entry
    ? entry.state === "ready"
      ? `Ready (${entry.kind ?? "auto"}, ${entry.varCount ?? 0} vars)`
      : entry.state === "resolving"
        ? "Resolving…"
        : entry.state === "failed"
          ? `Failed: ${entry.reason ?? "unknown"}`
          : entry.state === "idle"
            ? "Detected (not yet resolved)"
            : entry.enabled === "never"
              ? "Disabled by config"
              : "—"
    : "—";
  return (
    <div className="ae-devshell-refresh">
      <span className="ae-devshell-status">{status}</span>
      <button
        type="button"
        className="ae-settings-secondary"
        disabled={!root}
        onClick={() => {
          if (root) {
            refreshDevshell(root).catch((err) => {
              console.warn("devshell refresh failed:", err);
            });
          }
        }}
      >
        Refresh now
      </button>
    </div>
  );
}
