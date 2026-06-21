import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import A2UIRenderer from "./components/A2UIRenderer";
import { ExtensionRegistry } from "./extensions/ExtensionRegistry";
import { ExtensionRegistryProvider } from "./extensions/ExtensionRegistryProvider";
import { defaultLayoutExtension } from "./extensions/default-layout";
import {
  reconcileFrontendModules,
  type ExtensionFrontendModule,
} from "./extensions/extensionFrontendLoader";
import { injectThemeStyle } from "./hooks/extensionsHydration/themes";
import { TERMINAL_REPLAY_MAX } from "./hooks/useTabs";
import {
  replayHighlightGrammars,
  type ExtensionHighlightGrammar,
} from "./hooks/bridgeMessageHandlers/extensionHighlightGrammars";
import {
  canvasWindowSurfaceId,
  normalizeWindowState,
  type NativeCanvasWindowRecord,
} from "./nativeWindows";
import { cycleShareMode, type ShareMode } from "./utils/shareMode";
import type { A2UIComponent } from "./types/a2ui";

export interface NativeCanvasWindowAppProps {
  id: string;
}

type BridgeHydrationMessage = {
  type?: string;
  [key: string]: unknown;
};

const SAVE_DEBOUNCE_MS = 150;

function shellShareModeFromRecord(
  record: NativeCanvasWindowRecord | null,
  tabId: string,
): ShareMode {
  const tabs =
    (normalizeWindowState(record?.state).tabs as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
  const tab = tabs.find((item) => item.id === tabId);
  const shell = tab?.shell;
  if (!shell || typeof shell !== "object") return "private";
  const mode = (shell as Record<string, unknown>).shareMode;
  return typeof mode === "string" ? (mode as ShareMode) : "private";
}

export default function NativeCanvasWindowApp({
  id,
}: NativeCanvasWindowAppProps) {
  const [registry] = useState(() => {
    const r = new ExtensionRegistry();
    r.register(defaultLayoutExtension);
    return r;
  });
  const [record, setRecord] = useState<NativeCanvasWindowRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrationGen, setHydrationGen] = useState(0);
  const recordRef = useRef<NativeCanvasWindowRecord | null>(null);
  const frontendModulesRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<number | null>(null);

  const applyRecord = useCallback((next: NativeCanvasWindowRecord | null) => {
    recordRef.current = next;
    setError(null);
    setRecord(next);
    if (next) {
      emit("native-canvas-window-ready", { id: next.id }).catch(() => {
        /* readiness is best-effort; callers also have bounded waits */
      });
    }
  }, []);

  const scheduleSave = useCallback((next: NativeCanvasWindowRecord) => {
    recordRef.current = next;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const current = recordRef.current;
      if (!current) return;
      invoke("native_window_save_canvas", { record: current }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const updateRecord = useCallback(
    (updater: (prev: NativeCanvasWindowRecord) => NativeCanvasWindowRecord) => {
      setRecord((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const hydrateFrontendModules = useCallback(
    (modules: ExtensionFrontendModule[]) => {
      const previous = frontendModulesRef.current;
      const { loaded, unregistered } = reconcileFrontendModules(
        previous,
        modules,
        registry,
      );
      frontendModulesRef.current = new Map(
        modules.map((module) => [module.name, module.code]),
      );
      for (const module of loaded) {
        if (module.error) {
          console.warn(
            `extension frontend module ${module.name}: ${module.error}`,
          );
        }
      }
      if (loaded.length > 0 || unregistered.length > 0) {
        setHydrationGen((n) => n + 1);
      }
    },
    [registry],
  );

  const applyHydrationMessage = useCallback(
    (message: BridgeHydrationMessage) => {
      if (message.type === "ready") {
        registry.setTemplates(
          (message.extensionComponents as
            | Record<string, unknown>
            | undefined) ?? {},
        );
        setHydrationGen((n) => n + 1);
        for (const theme of (message.extensionThemes as
          | Parameters<typeof injectThemeStyle>[0][]
          | undefined) ?? []) {
          injectThemeStyle(theme);
        }
        hydrateFrontendModules(
          (message.extensionFrontendModules as
            | ExtensionFrontendModule[]
            | undefined) ?? [],
        );
        replayHighlightGrammars(
          (message.extensionHighlightGrammars as
            | ExtensionHighlightGrammar[]
            | undefined) ?? [],
        );
        return;
      }
      if (message.type === "extension_components") {
        registry.setTemplates(
          (message.components as Record<string, unknown> | undefined) ?? {},
        );
        setHydrationGen((n) => n + 1);
        return;
      }
      if (message.type === "extension_frontend_modules") {
        hydrateFrontendModules(
          (message.modules as ExtensionFrontendModule[] | undefined) ?? [],
        );
        return;
      }
      if (message.type === "extension_themes") {
        for (const theme of (message.themes as
          | Parameters<typeof injectThemeStyle>[0][]
          | undefined) ?? []) {
          injectThemeStyle(theme);
        }
        return;
      }
      if (message.type === "extension_highlight_grammars") {
        replayHighlightGrammars(
          (message.grammars as ExtensionHighlightGrammar[] | undefined) ?? [],
        );
        return;
      }
      if (message.type === "register_highlight_grammar") {
        const lang = message.lang;
        const grammar = message.grammar;
        if (typeof lang === "string" && grammar) {
          replayHighlightGrammars([{ lang, grammar }]);
        }
      }
    },
    [hydrateFrontendModules, registry],
  );

  useEffect(() => {
    const unlisten = listen<{ tabId: string; content: string }>(
      "shell-output",
      (event) => {
        const { tabId, content } = event.payload;
        if (!tabId || typeof content !== "string" || content.length === 0) {
          return;
        }
        const currentState = normalizeWindowState(recordRef.current?.state);
        const tabs = currentState.tabs;
        if (!Array.isArray(tabs) || !tabs.some((tab) => tab?.id === tabId)) {
          return;
        }
        window.dispatchEvent(
          new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
        );
        updateRecord((prev) => {
          const state = normalizeWindowState(prev.state);
          const prevTabs = state.tabs;
          if (!Array.isArray(prevTabs)) return prev;
          let matched = false;
          const nextTabs = prevTabs.map((tab) => {
            if (!tab || typeof tab !== "object" || tab.id !== tabId) return tab;
            matched = true;
            const next = `${String(tab.terminalBuffer ?? "")}${content}`;
            return {
              ...tab,
              terminalBuffer:
                next.length > TERMINAL_REPLAY_MAX
                  ? next.slice(next.length - TERMINAL_REPLAY_MAX)
                  : next,
            };
          });
          if (!matched) return prev;
          return { ...prev, state: { ...state, tabs: nextTabs } };
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateRecord]);

  useEffect(() => {
    let disposed = false;
    invoke<NativeCanvasWindowRecord | null>("native_window_get_canvas", { id })
      .then((next) => {
        if (disposed) return;
        if (!next) {
          setError(`Window "${id}" was not found.`);
          return;
        }
        applyRecord({
          ...next,
          state: normalizeWindowState(next.state),
        });
      })
      .catch((err) => {
        if (!disposed)
          setError(err instanceof Error ? err.message : String(err));
      });

    const unlistenRecord = listen<NativeCanvasWindowRecord>(
      "native-window-record",
      (event) => {
        if (event.payload?.id !== id) return;
        applyRecord({
          ...event.payload,
          state: normalizeWindowState(event.payload.state),
        });
      },
    );
    const unlistenClosed = listen<{ id?: string }>(
      "native-window-closed",
      (event) => {
        if (event.payload?.id === id) applyRecord(null);
      },
    );
    const unlistenAgent = listen<string>("agent-response", (event) => {
      try {
        applyHydrationMessage(JSON.parse(event.payload));
      } catch {
        /* ignore non-JSON bridge noise */
      }
    });

    unlistenAgent
      .then(() =>
        invoke("agent_command", {
          payload: JSON.stringify({ type: "report" }),
        }),
      )
      .catch(() => {
        /* main window owns bridge boot; this is just a replay request */
      });

    return () => {
      disposed = true;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      unlistenRecord.then((fn) => fn());
      unlistenClosed.then((fn) => fn());
      unlistenAgent.then((fn) => fn());
    };
  }, [applyHydrationMessage, applyRecord, id]);

  const handleStateChange = useCallback(
    (
      next:
        | Record<string, unknown>
        | ((prev: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      updateRecord((prev) => {
        const current = normalizeWindowState(prev.state);
        const state =
          typeof next === "function"
            ? normalizeWindowState(next(current))
            : normalizeWindowState(next);
        return { ...prev, state };
      });
    },
    [updateRecord],
  );

  const handleA2UIEvent = useCallback(
    (component: A2UIComponent, eventType: string, data?: unknown) => {
      if (
        component.type !== "shell-canvas" ||
        eventType !== "cycle-share-mode"
      ) {
        return false;
      }
      const payload =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      const tabId = typeof payload.tabId === "string" ? payload.tabId : "";
      if (!tabId) return true;
      const nextMode = cycleShareMode(
        shellShareModeFromRecord(recordRef.current, tabId),
      );
      invoke<ShareMode>("shell_set_share_mode", { tabId, mode: nextMode })
        .then((applied) => {
          emit("native-terminal-share-mode", {
            tabId,
            shareMode: applied,
          }).catch(() => {
            /* main app mirror is best-effort; Rust remains authoritative */
          });
          updateRecord((prev) => ({
            ...prev,
            state: {
              ...normalizeWindowState(prev.state),
              tabs: (
                (normalizeWindowState(prev.state).tabs as
                  | Array<Record<string, unknown>>
                  | undefined) ?? []
              ).map((tab) =>
                tab.id === tabId && tab.shell && typeof tab.shell === "object"
                  ? {
                      ...tab,
                      shell: {
                        ...(tab.shell as Record<string, unknown>),
                        shareMode: applied,
                      },
                    }
                  : tab,
              ),
            },
          }));
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      return true;
    },
    [updateRecord],
  );

  if (error) {
    return (
      <div className="app ae-native-canvas-window">
        <div className="ae-native-canvas-empty">{error}</div>
      </div>
    );
  }

  if (!record) {
    return (
      <div className="app ae-native-canvas-window">
        <div className="ae-native-canvas-empty">Loading canvas…</div>
      </div>
    );
  }

  return (
    <ExtensionRegistryProvider registry={registry}>
      <div
        className="app ae-native-canvas-window"
        data-hydration-gen={hydrationGen}
      >
        <A2UIRenderer
          payload={{ components: record.components }}
          state={record.state}
          onStateChange={handleStateChange}
          onEvent={handleA2UIEvent}
          tabId={record.tabId}
          surfaceId={canvasWindowSurfaceId(record.id)}
          windowId={record.id}
        />
      </div>
    </ExtensionRegistryProvider>
  );
}
