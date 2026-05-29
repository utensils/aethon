import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  PaletteItem,
  PaletteMode,
} from "../../extensions/default-layout/palette-items";
import type { UseUiOverlaysContext } from "./types";

type PaletteOverlayContext = Pick<
  UseUiOverlaysContext,
  | "setState"
  | "stateRef"
  | "pushNotification"
  | "setActiveTab"
  | "newTab"
  | "newEditorTab"
  | "setActiveProjectById"
  | "openProjectFromPicker"
  | "closeTab"
  | "nextTab"
  | "toggleTerminalAndFocus"
  | "toggleFocusComposerTerminal"
  | "clearChat"
  | "stopPrompt"
  | "adjustZoom"
  | "resetZoom"
  | "setTheme"
  | "setModel"
  | "activateLayoutById"
  | "sendChat"
  | "slashCommandsRef"
  | "slashContext"
>;

export function usePaletteOverlay(ctx: PaletteOverlayContext) {
  const {
    setState,
    stateRef,
    pushNotification,
    setActiveTab,
    newTab,
    newEditorTab,
    setActiveProjectById,
    openProjectFromPicker,
    closeTab,
    nextTab,
    toggleTerminalAndFocus,
    toggleFocusComposerTerminal,
    clearChat,
    stopPrompt,
    adjustZoom,
    resetZoom,
    setTheme,
    setModel,
    activateLayoutById,
    sendChat,
    slashCommandsRef,
    slashContext,
  } = ctx;

  function openPalette(mode: PaletteMode) {
    setState((prev) => {
      const nextPalette: Record<string, unknown> = {
        ...((prev.palette as Record<string, unknown> | undefined) ?? {}),
        open: true,
        mode,
        query: "",
        selectedIndex: 0,
      };
      if (mode === "files") {
        nextPalette.files = [];
        nextPalette.projectPath = null;
      }
      return { ...prev, palette: nextPalette };
    });

    if (mode === "files") {
      const project = stateRef.current.project as { path?: string } | undefined;
      const root = project?.path ?? "";
      if (!root) return;
      void invoke<string[]>("fs_walk_project", { root })
        .then((paths) => {
          const current =
            (stateRef.current.project as { path?: string } | undefined)?.path ??
            "";
          if (current !== root) return;
          const normalized = root.replace(/\/+$/, "");
          const files = paths.map((path) => {
            const rel = path.startsWith(normalized + "/")
              ? path.slice(normalized.length + 1)
              : path;
            return { path, rel };
          });
          setState((prev) => ({
            ...prev,
            palette: { ...(prev.palette ?? {}), files, projectPath: root },
          }));
        })
        .catch(() => {
          /* ignore — palette falls back to empty file list */
        });
    }
  }

  function closePalette() {
    setState((prev) => ({
      ...prev,
      palette: {
        ...(prev.palette ?? {}),
        open: false,
        query: "",
        selectedIndex: 0,
      },
    }));
  }

  async function runPaletteItem(item: PaletteItem) {
    const p = item.payload;
    switch (p.kind) {
      case "tab":
        setActiveTab(p.tabId);
        return;
      case "session":
        newTab(p.sessionId, p.label, {
          restoredSession: true,
          ...(p.cwd ? { cwd: p.cwd } : {}),
        });
        return;
      case "project":
        setActiveProjectById(p.projectId);
        return;
      case "open-project":
        openProjectFromPicker();
        return;
      case "slash": {
        const cmd = slashCommandsRef.current.find((c) => c.name === p.name);
        if (!cmd) {
          pushNotification({
            title: `Unknown command /${p.name}`,
            kind: "error",
          });
          return;
        }
        try {
          if (cmd.passthroughToAgent) {
            const args = p.args ? ` ${p.args}` : "";
            await sendChat(`/${p.name}${args}`);
            return;
          }
          await cmd.run(p.args ?? "", slashContext());
        } catch (err) {
          pushNotification({
            title: `/${p.name} failed`,
            message: String(err),
            kind: "error",
          });
        }
        return;
      }
      case "keybinding":
        invoke("dispatch_a2ui_event", {
          event: JSON.stringify({
            componentId: `keybinding__tpl__${p.combo}`,
            componentType: "keybinding",
            templateRootType: "keybinding",
            eventType: "invoke",
            data: { combo: p.combo, action: p.action },
          }),
          tabId: stateRef.current.activeTabId,
        }).catch(() => {
          /* ignore — bridge gone */
        });
        return;
      case "layout":
        activateLayoutById(p.layoutId);
        return;
      case "theme":
        setTheme(p.themeId);
        return;
      case "model":
        await setModel(p.modelId);
        return;
      case "action":
        if (p.action === "builtin:meta+t") newTab();
        else if (p.action === "builtin:meta+w") {
          const id = stateRef.current.activeTabId as string | undefined;
          if (id) closeTab(id);
        } else if (p.action === "builtin:meta+shift+]") nextTab(1);
        else if (p.action === "builtin:meta+shift+[") nextTab(-1);
        else if (p.action === "builtin:meta+`") toggleTerminalAndFocus();
        else if (p.action === "builtin:meta+0") toggleFocusComposerTerminal();
        else if (p.action === "builtin:meta+k") clearChat();
        else if (p.action === "builtin:meta+.") void stopPrompt();
        else if (p.action === "builtin:meta+p") openPalette("files");
        else if (p.action === "builtin:meta+shift+p") openPalette("commands");
        else if (p.action === "builtin:meta+=") adjustZoom(0.1);
        else if (p.action === "builtin:meta+-") adjustZoom(-0.1);
        else if (p.action === "builtin:meta+shift+0") resetZoom();
        return;
      case "file":
        newEditorTab(p.filePath);
        return;
    }
  }

  // Editor menubar → "Go to File…" opens quick-open without duplicating
  // the palette wiring. A ref keeps the listener stable across renders.
  const openPaletteRef = useRef(openPalette);
  useEffect(() => {
    openPaletteRef.current = openPalette;
  });
  useEffect(() => {
    const onGotoFile = () => openPaletteRef.current("files");
    window.addEventListener("aethon:goto-file", onGotoFile);
    return () => window.removeEventListener("aethon:goto-file", onGotoFile);
  }, []);

  return {
    openPalette,
    closePalette,
    runPaletteItem,
  };
}
