import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { A2UIPayload } from "../types/a2ui";
import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import { shellQuoteAll } from "../utils/shellQuote";
import { TERMINAL_REPLAY_MAX } from "./useTabs";
import type { NotificationInput } from "./useNotifications";

export interface UseOsEdgesContext {
  bootLayout: A2UIPayload;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;

  // ─── Refs from useChat / useBridgeMessages ──────────────────────────
  activeResponseIdRef: MutableRefObject<string | null>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  hangWarnNotifId: (tabId: string) => string;

  // ─── Live config refs (from useBootConfig) ──────────────────────────
  autoRestartAgentRef: MutableRefObject<boolean>;

  // ─── Tab actions (from useTabs) ─────────────────────────────────────
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  newTab: () => void;
  newShellTab: () => void;
  closeTab: (tabId: string) => void;
  nextTab: (direction: 1 | -1) => void;

  // ─── Chat helpers (from useChat) ────────────────────────────────────
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendSystem: (text: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
  clearChat: () => void;
  stopPrompt: () => Promise<void>;

  // ─── Focus + chrome ─────────────────────────────────────────────────
  toggleTerminal: () => void;
  toggleFilesSidebar: () => void;
  openSettings: (section?: string) => void;

  // ─── Notifications ──────────────────────────────────────────────────
  pushNotification: (n: NotificationInput) => string;
  dismissNotification: (id: string) => void;

  // ─── Updater ────────────────────────────────────────────────────────
  checkForUpdates: () => Promise<void>;
}

/**
 * The big OS-edges effect: PTY streams (`shell-output`, `shell-exit`,
 * `shell-title`), agent supervisor signals (`agent-reloaded`,
 * `agent-crashed`, `agent-stderr`), the native `menu` event, OS
 * drag-drop of file paths, and clipboard image paste.
 *
 * Bridge IPC + JSON-line dispatch live in `useBridgeMessages` — this
 * hook only owns the OS-edge listeners that aren't routed through the
 * bridge response stream. The split is load-bearing: the bridge can
 * be respawned while these listeners stay attached, so a clean teardown
 * never drops a PTY exit code or a stderr line.
 *
 * Hang-warn refs (`hangWarnTimersRef`, `hangWarnActiveRef`) are passed
 * through to `useBridgeMessages` for scheduling but fully cleared here
 * on supervisor signals — the bridge respawn invalidates every pending
 * warning.
 */
export function useOsEdges(ctx: UseOsEdgesContext): void {
  const {
    setState,
    stateRef,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    hangWarnNotifId,
    autoRestartAgentRef,
    updateTab,
    newTab,
    newShellTab,
    closeTab,
    nextTab,
    appendMessage,
    appendSystem,
    setStatusFlags,
    clearChat,
    stopPrompt,
    toggleTerminal,
    toggleFilesSidebar,
    openSettings,
    pushNotification,
    dismissNotification,
    checkForUpdates,
  } = ctx;
  const { bootLayout } = ctx;

  useEffect(() => {
    const restartAgentProcess = (tabId?: string) => {
      if (!tabId) {
        return invoke("start_agent");
      }
      const tab = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
        (t) => t.id === tabId && t.kind === "agent",
      );
      const payload: Record<string, unknown> = { type: "tab_open", tabId };
      if (tab?.cwd) payload.cwd = tab.cwd;
      if (tab?.model) payload.model = tab.model;
      return invoke("agent_command", { payload: JSON.stringify(payload) });
    };

    // The boot sequence (start_agent → boot_layout → report) and the
    // `agent-response` listener live in `useBridgeMessages` — see the
    // call site near the bottom of App.tsx. The remaining listeners
    // below own OS-edge events (PTY streams, agent supervisor signals,
    // native menu, drag-drop, paste) that aren't bridge messages, so
    // they stay in this effect.

    // M6 P1: shell-output streams a PTY chunk. Append to the originating
    // shell-tab's terminalBuffer and dispatch a per-tab window event so
    // the shell-canvas composite (subscribed by tabId) writes the chunk
    // to its xterm. Inactive shell-tab output stays buffered until the
    // user switches to it (replay-on-mount, same pattern as agent
    // bash output for the read-only Terminal panel).
    const unlistenShellOutput = listen<{ tabId: string; content: string }>(
      "shell-output",
      (event) => {
        const { tabId, content } = event.payload;
        if (!tabId || typeof content !== "string") return;
        updateTab(tabId, (t) => {
          const next = t.terminalBuffer + content;
          const trimmed =
            next.length > TERMINAL_REPLAY_MAX
              ? next.slice(next.length - TERMINAL_REPLAY_MAX)
              : next;
          return { ...t, terminalBuffer: trimmed };
        });
        window.dispatchEvent(
          new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
        );
      },
    );

    // M6 P1: shell-exit fires once when the PTY child process ends.
    // Flip the tab's shell.shellState to "exited" so the canvas can
    // show a closed-process indicator; the slot is left in the Rust
    // registry until tab close (cleanup is idempotent).
    const unlistenShellExit = listen<{ tabId: string; code: number | null }>(
      "shell-exit",
      (event) => {
        const { tabId, code } = event.payload;
        if (!tabId) return;
        updateTab(tabId, (t) => {
          if (t.kind !== "shell" || !t.shell) return t;
          return {
            ...t,
            shell: {
              ...t.shell,
              shellState: "exited",
              ...(typeof code === "number" ? { exitCode: code } : {}),
            },
          };
        });
      },
    );

    // M6 follow-up: shell-title fires whenever a PTY's stdout contains
    // an OSC 0/1/2 title-set sequence. Replace the tab label with the
    // shell-emitted title so the user sees `vim · README.md` /
    // `user@host` / `htop` instead of the static `Shell N`. Falls
    // back to the default label if the user never opens a tool that
    // reports titles — that's the existing behaviour.
    const unlistenShellTitle = listen<{ tabId: string; title: string }>(
      "shell-title",
      (event) => {
        const { tabId, title } = event.payload;
        if (!tabId || typeof title !== "string" || title.length === 0) return;
        const safe = title.length > 64 ? `${title.slice(0, 61)}…` : title;
        updateTab(tabId, (t) => {
          if (t.kind !== "shell" || t.label === safe) return t;
          return { ...t, label: safe };
        });
      },
    );

    const unlistenReload = listen<string>("agent-reloaded", () => {
      activeResponseIdRef.current = null;
      for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
      hangWarnTimersRef.current.clear();
      for (const tid of hangWarnActiveRef.current)
        dismissNotification(hangWarnNotifId(tid));
      hangWarnActiveRef.current.clear();
      setStatusFlags({ waiting: false, status: "agent reloaded" });
      // Re-prime the full bridge handshake. A bare start_agent emits the
      // bridge's startup ready, but does not replay the frontend boot layout
      // or request a post-layout ready snapshot, which leaves hot-reload
      // restore dependent on message timing.
      (async () => {
        await invoke("start_agent");
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "boot_layout",
            payload: bootLayout,
          }),
        });
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "report" }),
        });
      })().catch(() => {
        /* surfaced by the next user action */
      });
    });

    // P5: bridge crash recovery. Rust supervisor emits this when the
    // bun child exits unexpectedly (intentional hot-reload kills go
    // through `agent-reloaded` instead). Clear all per-tab waiting
    // state, surface a notice, and auto-restart per [shell] config.
    const unlistenCrashed = listen<{
      pid?: number;
      tabId?: string | null;
      stderrTail?: string[];
    }>("agent-crashed", (event) => {
      const tail = event.payload?.stderrTail ?? [];
      const crashedTabId =
        typeof event.payload?.tabId === "string" &&
        event.payload.tabId.length > 0
          ? event.payload.tabId
          : undefined;
      const lastLine = tail.length > 0 ? tail[tail.length - 1] : "no stderr";
      activeResponseIdRef.current = null;
      if (crashedTabId) {
        const h = hangWarnTimersRef.current.get(crashedTabId);
        if (h !== undefined) clearTimeout(h);
        hangWarnTimersRef.current.delete(crashedTabId);
        if (hangWarnActiveRef.current.delete(crashedTabId)) {
          dismissNotification(hangWarnNotifId(crashedTabId));
        }
      } else {
        for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
        hangWarnTimersRef.current.clear();
        for (const tid of hangWarnActiveRef.current)
          dismissNotification(hangWarnNotifId(tid));
        hangWarnActiveRef.current.clear();
      }
      // Clear waiting/queue for the affected process. A tab worker crash
      // should not mark unrelated agents idle; the global bridge crash
      // still clears all because app-wide state is gone.
      setState((prev) => {
        const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) =>
          !crashedTabId || t.id === crashedTabId
            ? {
                ...t,
                waiting: false,
                queueCount: 0,
              }
            : t,
        );
        return {
          ...prev,
          tabs,
          ...(!crashedTabId || prev.activeTabId === crashedTabId
            ? { waiting: false, queueCount: 0 }
            : {}),
          status: "agent crashed",
        };
      });
      const willAutoRestart = autoRestartAgentRef.current;
      const notificationId = crashedTabId
        ? `ae-agent-crashed:${crashedTabId}`
        : "ae-agent-crashed";
      pushNotification({
        id: notificationId,
        title: "Agent process exited unexpectedly",
        message: lastLine.slice(0, 200),
        kind: "error",
        // Keep visible until the user dismisses or restart succeeds —
        // a transient toast would race a user who's away from the
        // keyboard while a long agent turn died.
        durationMs: null,
        actions: willAutoRestart
          ? [{ label: "Dismiss", action: "ae-agent-crashed:dismiss" }]
          : [
              {
                label: "Restart",
                action: crashedTabId
                  ? `ae-agent-crashed:restart:${crashedTabId}`
                  : "ae-agent-crashed:restart",
              },
              { label: "Dismiss", action: "ae-agent-crashed:dismiss" },
            ],
      });
      if (willAutoRestart) {
        // Brief delay so the user actually sees the notice flash
        // before the next request silently respawns. The next chat
        // send will respawn anyway via ensure_agent_spawned, but
        // priming here means the system-prompt + ready handshake
        // happens up-front.
        window.setTimeout(() => {
          restartAgentProcess(crashedTabId).catch(() => {
            /* respawn deferred to next user action */
          });
        }, 500);
      }
    });

    // Mirror agent stderr into the chat as a system message — when the bridge
    // dies on startup this is the only signal we have.
    const unlistenStderr = listen<string>("agent-stderr", (event) => {
      const text = event.payload?.toString().trim();
      if (!text) return;
      // Surface only real failures. Two tiers:
      //   1. Bridge log lines tagged WARN / ERROR / FATAL (the bun
      //      logger writes `<ISO> LEVEL scope: msg`). We deliberately
      //      ignore INFO/DEBUG so noisy progress lines like
      //      `… load took 0ms (loaded=0 failed=0)` don't pop into chat
      //      just because they contain the substring "fail".
      //   2. Raw uncaught throws / panics / module-resolution errors
      //      that escape the logger entirely (matched by anchor or
      //      well-known prefixes, not loose substrings).
      const isLeveledFailure = /\b(WARN|ERROR|FATAL)\b/.test(text);
      const isRawCrash =
        /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|panic:)/i.test(
          text,
        ) ||
        /\bthrow\s+new\s|\bCannot\s+find\s+(module|package)\b|\bEACCES\b|\bENOENT\b/i.test(
          text,
        );
      // Routine extension feedback (size-guard rejections, etc.) goes to bridge
      // logs only — surfacing it to chat would spam the feed when an extension
      // misbehaves on a setInterval.
      const isExtensionNoise = /\b(WARN|INFO)\s+ext-state:/.test(text);
      if ((isLeveledFailure || isRawCrash) && !isExtensionNoise) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "system",
          text: `[agent stderr] ${text}`,
        });
      }
      // Always log to webview console for debug skill access.
      console.warn("[agent stderr]", text);
    });

    // Native menu activations land here. The Rust shell emits the
    // menu item id; we route the same way the keyboard shortcuts do
    // so menu and Cmd+T / Cmd+Shift+] / etc. always do the same thing.
    const unlistenMenu = listen<string>("menu", (event) => {
      const id = event.payload;
      // Extension menu items use the `ext:<action>` prefix so they don't
      // collide with built-in ids. Route them through the existing
      // a2ui_event channel as {componentType:"menu-item",
      // componentId:"menu-item__tpl__<action>", data:{action}} so a
      // paired aethon.onEvent({componentType:"menu-item",
      // descendantId:"<action>"}, handler) fires.
      if (id.startsWith("ext:")) {
        const action = id.slice(4);
        invoke("dispatch_a2ui_event", {
          event: JSON.stringify({
            componentId: `menu-item__tpl__${action}`,
            componentType: "menu-item",
            templateRootType: "menu-item",
            eventType: "invoke",
            data: { action },
          }),
          tabId: stateRef.current.activeTabId,
        }).catch(() => {
          /* bridge gone or webview reload mid-flight */
        });
        return;
      }
      switch (id) {
        // M6 restructure: "File → New Tab" (Cmd+T) opens an agent tab
        // — the menu can't observe webview focus, so it picks the
        // safer default. The webview keydown handler intercepts Cmd+T
        // when focus is in the bottom terminal panel and routes to
        // newShellTab there. "File → New Shell Tab" (Cmd+Shift+T) is
        // the explicit shell-tab path. The legacy "new_agent_tab" id
        // is kept as an alias in case any older payload references it.
        case "new_tab":
        case "new_agent_tab":
          newTab();
          break;
        case "new_shell_tab":
          newShellTab();
          break;
        case "close_tab": {
          const activeId = stateRef.current.activeTabId as string | undefined;
          if (activeId) closeTab(activeId);
          break;
        }
        case "next_tab":
          nextTab(1);
          break;
        case "prev_tab":
          nextTab(-1);
          break;
        case "toggle_terminal":
          toggleTerminal();
          break;
        case "toggle_files": {
          // Forward to the FileTreePanel's hidden window event so the
          // panel toggles regardless of which surface (menu, sidebar
          // item, future shortcut) fired the request.
          window.dispatchEvent(new Event("aethon:toggle-file-tree"));
          break;
        }
        case "toggle_files_sidebar":
          toggleFilesSidebar();
          break;
        case "manage_extensions":
          openSettings("extensions");
          break;
        case "clear_chat":
          clearChat();
          break;
        case "stop_prompt":
          void stopPrompt();
          break;
        case "check_updates": {
          checkForUpdates().catch((err) => {
            appendSystem(`Update check failed: ${err}`);
          });
          break;
        }
        case "help_docs": {
          openUrl("https://utensils.io/aethon/").catch(() => {
            /* opener errors are noisy and rarely actionable */
          });
          break;
        }
        case "help_issues": {
          openUrl("https://github.com/utensils/aethon/issues/new").catch(() => {
            /* opener errors are noisy and rarely actionable */
          });
          break;
        }
      }
    });

    // P4: drag-and-drop file paths from the OS. Tauri 2's webview
    // exposes the paths directly (HTML5 dataTransfer is sandboxed and
    // only yields File handles). Routing:
    //   * Drop on the bottom terminal panel while a shell sub-tab is
    //     active, or anywhere when the active top-level tab is a shell
    //     → write shell-quoted POSIX path(s) into the PTY via
    //     `shell_input`. Each path is single-quote-wrapped via the
    //     shellQuote helper so spaces / metacharacters never break the
    //     paste into multiple tokens.
    //   * Otherwise (active tab is an agent tab) → append
    //     `@<absolute-path>` tokens to the draft.
    // Position hit-test uses `document.elementFromPoint` against the
    // physical-to-CSS-pixel-converted drop coordinates so the user can
    // drop directly onto the panel they want to receive the path.
    const dragDropDisposer = (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        return await getCurrentWebview().onDragDropEvent((evt) => {
          if (evt.payload.type !== "drop") return;
          const paths = evt.payload.paths ?? [];
          if (paths.length === 0) return;
          const activeId = stateRef.current.activeTabId as string | undefined;
          if (!activeId) return;
          const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
          const tab = tabs.find((t) => t.id === activeId);
          if (!tab) return;

          // Resolve which shell — if any — should receive the drop.
          // Top-level shell tab wins outright; otherwise, hit-test the
          // drop position against the bottom terminal panel and inspect
          // the active sub-tab.
          let targetShellId: string | null = null;
          if (tab.kind === "shell") {
            targetShellId = tab.id;
          } else {
            const pos = evt.payload.position;
            const dpr = window.devicePixelRatio || 1;
            const cssX = pos.x / dpr;
            const cssY = pos.y / dpr;
            const elem = document.elementFromPoint(cssX, cssY);
            const inPanel = elem?.closest(".ae-terminal-panel") ?? null;
            if (inPanel) {
              const tp =
                (stateRef.current.terminalPanel as
                  | { activeSubId?: string }
                  | undefined) ?? {};
              const subId = tp.activeSubId;
              if (subId && subId !== "agent-bash") {
                const subTab = tabs.find((t) => t.id === subId);
                if (subTab && subTab.kind === "shell") {
                  targetShellId = subTab.id;
                }
              }
            }
          }

          if (targetShellId) {
            const data = shellQuoteAll(paths);
            void invoke("shell_input", {
              tabId: targetShellId,
              data,
            }).catch(() => {
              /* PTY closed mid-drop — drop silently */
            });
            return;
          }

          if (tab.kind !== "agent") return;
          const tokens = paths.map((p) => `@${p}`).join(" ");
          updateTab(activeId, (t) => ({
            ...t,
            draft: t.draft.length > 0 ? `${t.draft} ${tokens}` : tokens,
          }));
        });
      } catch (err) {
        console.warn("dragdrop subscribe failed:", err);
        return undefined;
      }
    })();

    // Image paste into the chat composer. Tauri webview surfaces clipboard
    // images via `event.clipboardData.items`; for each `image/*` item we
    // persist the bytes to `~/.aethon/pastes/<uuid>.<ext>` via the
    // `save_paste_image` Tauri command and insert `@<path>` into the
    // active agent tab's draft. The agent's existing read tool can then
    // pick up the image via the path. Files larger than the Rust 32 MiB
    // cap surface as a notification rather than silently dropping.
    const onClipboardPaste = (e: ClipboardEvent) => {
      const focused = document.activeElement;
      const composer = document.querySelector(".a2ui-chat-input");
      if (!composer || !focused || !composer.contains(focused)) return;
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageItems: DataTransferItem[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          imageItems.push(it);
        }
      }
      if (imageItems.length === 0) return;
      e.preventDefault();
      // Capture the target tab at paste time, NOT after the async save
      // resolves — otherwise pasting a slow-saving image in tab A and
      // switching to tab B before save_paste_image returns would
      // attach the @path token to whichever agent tab is active later.
      const targetId = stateRef.current.activeTabId as string | undefined;
      if (!targetId) return;
      const targetTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      const targetTab = targetTabs.find((t) => t.id === targetId);
      if (!targetTab || targetTab.kind !== "agent") return;
      void Promise.all(
        imageItems.map(async (item) => {
          const file = item.getAsFile();
          if (!file) return null;
          const buffer = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const ext = file.type.split("/")[1] ?? "png";
          try {
            const path = await invoke<string>("save_paste_image", {
              bytes,
              extension: ext,
            });
            return path;
          } catch (err) {
            pushNotification({
              id: "ae-paste-image-failed",
              title: "Image paste failed",
              message: err instanceof Error ? err.message : String(err),
              kind: "error",
              durationMs: 3000,
            });
            return null;
          }
        }),
      ).then((paths) => {
        const tokens = paths
          .filter((p): p is string => typeof p === "string")
          .map((p) => `@${p}`)
          .join(" ");
        if (tokens.length === 0) return;
        // Verify the captured tab still exists (the user could have
        // closed it during the async save). If it's gone, the @path
        // tokens are orphaned — better than appending to an unrelated
        // tab. The pasted file remains in ~/.aethon/pastes/ for manual
        // recovery.
        const stillExists = (stateRef.current.tabs as Tab[] | undefined)?.some(
          (t) => t.id === targetId,
        );
        if (!stillExists) return;
        updateTab(targetId, (t) => ({
          ...t,
          draft: t.draft.length > 0 ? `${t.draft} ${tokens}` : tokens,
        }));
      });
    };
    document.addEventListener("paste", onClipboardPaste, true);

    return () => {
      unlistenReload.then((fn) => fn());
      unlistenCrashed.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
      unlistenMenu.then((fn) => fn());
      unlistenShellOutput.then((fn) => fn());
      unlistenShellExit.then((fn) => fn());
      unlistenShellTitle.then((fn) => fn());
      dragDropDisposer.then((fn) => fn?.());
      document.removeEventListener("paste", onClipboardPaste, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
