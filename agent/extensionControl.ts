import type { AethonAgentState } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { saveDisabledExtensionsSnapshot } from "./disabled-extensions";
import { notify } from "./notifications";

export async function handleSetExtensionDisabled(
  state: AethonAgentState,
  deps: DispatcherDeps,
  notifDeps: { send: (m: Record<string, unknown>) => void },
  msg: InboundMessage,
): Promise<void> {
  const name = (msg as { name?: unknown }).name;
  const disabled = (msg as { disabled?: unknown }).disabled;
  if (typeof name !== "string" || !name) {
    deps.send({
      type: "error",
      message: "set_extension_disabled: name required",
    });
    return;
  }
  if (typeof disabled !== "boolean") {
    deps.send({
      type: "error",
      message: "set_extension_disabled: disabled must be boolean",
    });
    return;
  }
  const wasDisabled = state.disabledExtensions.has(name);
  if (disabled === wasDisabled) return; // no-op
  // Snapshot the prior meta so a save failure can restore both the
  // name and any metadata we'd just dropped/added.
  const priorMeta = state.disabledExtensionMeta.get(name);
  if (disabled) {
    state.disabledExtensions.add(name);
    // Capture source + projectRoot from the live loader registries.
    // `loadedExtensions` covers successful loads (this run); for the
    // common case where the user just clicked disable, the extension
    // is currently loaded. `loadFailures` covers extensions that
    // surfaced in the sidebar via a failed status. Anything missing
    // from both is preserved with its previous meta (if any) — we
    // never wipe a known scope just because the user toggled while
    // a different project was active.
    const loadedSource = state.loadedExtensions.get(name);
    const failureInfo = state.loadFailures.get(name);
    if (loadedSource) {
      const projectRoot =
        loadedSource === "project-directory"
          ? state.projectExtensionRoots.get(name)
          : undefined;
      state.disabledExtensionMeta.set(
        name,
        projectRoot
          ? { source: loadedSource, projectRoot }
          : { source: loadedSource },
      );
    } else if (failureInfo) {
      state.disabledExtensionMeta.set(
        name,
        failureInfo.projectRoot
          ? {
              source: failureInfo.source,
              projectRoot: failureInfo.projectRoot,
            }
          : { source: failureInfo.source },
      );
    }
    // If neither registry knows the extension, leave whatever meta
    // we already had (could be a legacy entry with no meta).
  } else {
    state.disabledExtensions.delete(name);
    state.disabledExtensionMeta.delete(name);
  }
  try {
    await saveDisabledExtensionsSnapshot(state.userDir, {
      names: state.disabledExtensions,
      meta: state.disabledExtensionMeta,
    });
  } catch (err) {
    // Persistence failed — revert the in-memory toggle so the next
    // operation sees the on-disk truth, and surface a notice instead
    // of a misleading success toast + bridge reload that would
    // re-load the extension and silently lose the user's intent.
    if (disabled) {
      state.disabledExtensions.delete(name);
      if (priorMeta) state.disabledExtensionMeta.set(name, priorMeta);
      else state.disabledExtensionMeta.delete(name);
    } else {
      state.disabledExtensions.add(name);
      if (priorMeta) state.disabledExtensionMeta.set(name, priorMeta);
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      message: `set_extension_disabled: persist failed: ${message}`,
    });
    void notify(state, notifDeps, {
      id: `aethon:extension-toggle:${name}`,
      title: `Could not ${disabled ? "disable" : "enable"} \`${name}\``,
      message: `Persist failed: ${message}`,
      kind: "error",
      durationMs: 6000,
    });
    return;
  }
  // Surface the change to the frontend immediately. The loaded set
  // doesn't change until restart; the sidebar shows a `(disabled)` row
  // by deriving from `loadedExtensions ∩ ¬disabledExtensions` plus the
  // explicit disabled list. We re-emit the lifecycle event so the
  // hydration handler can move the row to the right bucket.
  deps.send({
    type: "extension_lifecycle",
    name,
    source: "directory",
    status: disabled ? "disabled" : "enabled",
  });
  // Notify the user before signalling the bridge restart so the toast
  // is rendered before agent-reloaded clears the in-flight UI state.
  void notify(state, notifDeps, {
    id: `aethon:extension-toggle:${name}`,
    title: disabled ? `Disabled \`${name}\`` : `Enabled \`${name}\``,
    message: disabled
      ? "Reloading bridge to fully unload…"
      : "Reloading bridge to load…",
    kind: "info",
    durationMs: 4000,
  });
  // Ask the frontend to force-restart the bridge. We can't restart
  // ourselves from inside the bridge (the Tauri shell owns the child
  // and needs to flip its `agent_reload_in_progress` flag so the
  // supervisor emits `agent-reloaded` instead of `agent-crashed`).
  // The frontend's reload-required handler invokes `force_restart_agent`
  // — on respawn, the new bridge reads disabled-extensions.json on boot
  // and the loader honors it.
  deps.send({
    type: "reload_required",
    reason: `extension-toggle:${name}`,
  });
}
