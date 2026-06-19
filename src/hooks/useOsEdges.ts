import { useEffect } from "react";
import { subscribeShellStreams } from "./osEdges/shellStreams";
import { subscribeAgentReload } from "./osEdges/agentReload";
import { subscribeAgentCrash } from "./osEdges/agentCrash";
import { subscribeAgentStderr } from "./osEdges/agentStderr";
import { subscribeDevshellOutput } from "./osEdges/devshellOutput";
import { subscribeMenu } from "./osEdges/menu";
import { subscribeDragDrop } from "./osEdges/dragDrop";
import { subscribeClipboardPaste } from "./osEdges/clipboardPaste";
import type { UseOsEdgesContext } from "./osEdges/types";

export type { UseOsEdgesContext } from "./osEdges/types";

/**
 * The OS-edge listeners: PTY streams (`shell-output`, `shell-exit`,
 * `shell-title`), agent supervisor signals (`agent-reloaded`,
 * `agent-crashed`, `agent-stderr`), the native `menu` event, OS
 * drag-drop of file paths, and clipboard image paste.
 *
 * Bridge IPC + JSON-line dispatch live in `useBridgeMessages` — this
 * hook only owns the OS-edge listeners that aren't routed through the
 * bridge response stream. The split is load-bearing: the bridge can
 * be respawned while these listeners stay attached, so a clean
 * teardown never drops a PTY exit code or a stderr line.
 *
 * Implementation is split per OS edge under `./osEdges/`:
 *
 * - `types`           — UseOsEdgesContext
 * - `shellStreams`    — PTY output/exit/title listeners
 * - `agentReload`     — agent-reloaded → re-prime bridge handshake
 * - `agentCrash`      — agent-crashed → clear waiting + auto-restart
 * - `agentStderr`     — agent-stderr → filtered mirror into chat
 * - `menu`            — native menu activations (built-in + ext:* ids)
 * - `dragDrop`        — OS file drop into shell PTY or agent draft
 * - `clipboardPaste`  — image paste → save_paste_image + @path token
 *
 * Each subscriber takes a narrow Deps slice (refs + functions it
 * actually uses) and returns a cleanup function. The facade calls
 * them inside the single boot useEffect and tears them down on
 * unmount.
 *
 * Hang-warn refs (`hangWarnTimersRef`, `hangWarnActiveRef`) are
 * passed through to `useBridgeMessages` for scheduling but fully
 * cleared here on supervisor signals — the bridge respawn invalidates
 * every pending warning.
 */
export function useOsEdges(ctx: UseOsEdgesContext): void {
  useEffect(() => {
    const cleanups = [
      subscribeShellStreams({
        updateTab: ctx.updateTab,
        stateRef: ctx.stateRef,
        appendSystem: ctx.appendSystem,
        shellInheritEnvRef: ctx.shellInheritEnvRef,
      }),
      subscribeAgentReload({
        bootLayout: ctx.bootLayout,
        activeResponseIdRef: ctx.activeResponseIdRef,
        hangWarnTimersRef: ctx.hangWarnTimersRef,
        hangWarnActiveRef: ctx.hangWarnActiveRef,
        hangWarnNotifId: ctx.hangWarnNotifId,
        dismissNotification: ctx.dismissNotification,
        setStatusFlags: ctx.setStatusFlags,
      }),
      subscribeAgentCrash({
        setState: ctx.setState,
        stateRef: ctx.stateRef,
        activeResponseIdRef: ctx.activeResponseIdRef,
        hangWarnTimersRef: ctx.hangWarnTimersRef,
        hangWarnActiveRef: ctx.hangWarnActiveRef,
        hangWarnNotifId: ctx.hangWarnNotifId,
        dismissNotification: ctx.dismissNotification,
        autoRestartAgentRef: ctx.autoRestartAgentRef,
        pushNotification: ctx.pushNotification,
      }),
      subscribeAgentStderr({
        appendMessage: ctx.appendMessage,
        persistLocalChatMessage: ctx.persistLocalChatMessage,
      }),
      subscribeDevshellOutput({
        setState: ctx.setState,
        stateRef: ctx.stateRef,
        updateTab: ctx.updateTab,
      }),
      subscribeMenu({
        stateRef: ctx.stateRef,
        newTab: ctx.newTab,
        newShellTab: ctx.newShellTab,
        closeTab: ctx.closeTab,
        nextTab: ctx.nextTab,
        toggleTerminal: ctx.toggleTerminal,
        toggleFilesSidebar: ctx.toggleFilesSidebar,
        togglePlanMode: ctx.togglePlanMode,
        openSettings: ctx.openSettings,
        clearChat: ctx.clearChat,
        stopPrompt: ctx.stopPrompt,
        checkForUpdates: ctx.checkForUpdates,
        appendSystem: ctx.appendSystem,
      }),
      subscribeDragDrop({
        stateRef: ctx.stateRef,
        updateTab: ctx.updateTab,
      }),
      subscribeClipboardPaste({
        stateRef: ctx.stateRef,
        updateTab: ctx.updateTab,
        pushNotification: ctx.pushNotification,
      }),
    ];
    return () => {
      for (const fn of cleanups) fn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
