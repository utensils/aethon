/**
 * ShellCanvas — interactive PTY-backed terminal for shell tabs (M6 P1).
 * Distinct from Terminal: this composite has bidirectional input
 * (term.onData invokes shell_input) and is bound to a specific shell-tab
 * id (so it can subscribe to per-tab `aethon:shell-output:<tabId>` events
 * and resize the matching PTY via shell_resize). Mounts a fresh xterm
 * per tabId — switching tabs unmounts/remounts so scrollback isolation
 * is automatic.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import type { NumberValue, StringValue } from "../../../types/a2ui";
import type { ShareMode } from "../../../utils/shareMode";
import { resolveNumber, resolveString } from "../../../utils/dataBinding";
import { RegistryComponent } from "../../../components/A2UIRenderer";
import { remoteHostInvoke } from "../../../services/remote";
import { isRemoteHostId } from "../../../remoteInvoke";
import type {
  A2UIEventHandler,
  BuiltinComponentProps,
} from "../../../components/A2UIRenderer";
import {
  applyTerminalHostUiScale,
  applyTerminalUiScale,
  observeTerminalTheme,
  observeTerminalUiScale,
  readAppUiScale,
  readTerminalTheme,
  terminalFitDelay,
  terminalFontSizeForUiScale,
  TERMINAL_UI_SCALE_SETTLE_MS,
} from "../terminal-helpers";
import { registerTerminalUrlLinks } from "../terminal-linkifier";
import { decideShellResize, shouldSkipResize, type ShellDims } from "./resize";

const TERMINAL_PTY_RESIZE_SETTLE_MS = 120;

export function ShellCanvas({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    /** Shell tab id this canvas is bound to. Resolved via $ref so the
     *  layout can pass `/activeTabId` and have the canvas track the
     *  active shell tab automatically. */
    tabId?: StringValue;
    fontSize?: NumberValue;
    bootGreeting?: StringValue;
  };
  const tabId = props.tabId ? resolveString(props.tabId, state) : "";
  const fontSize = props.fontSize ? resolveNumber(props.fontSize, state) : 13;
  const bootGreeting = props.bootGreeting
    ? resolveString(props.bootGreeting, state)
    : "";

  // Pull the bound tab's shell metadata (cwd, command, share mode, dims)
  // so the status line can reflect them live. Read-only — mutations flow
  // through the `onEvent("set-share-mode", ...)` route below.
  type ShellMetaShape = {
    cwd?: string;
    command?: string;
    shareMode?: ShareMode;
    shellState?: string;
  };
  const tabs =
    (state["tabs"] as
      | Array<{ id: string; kind?: string; hostId?: string; shell?: ShellMetaShape }>
      | undefined) ?? [];
  const boundTab = tabs.find((t) => t.id === tabId);
  const shell = boundTab?.shell;
  const hostId = boundTab?.hostId;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabIdRef = useRef<string>(tabId);
  const fontSizeRef = useRef(fontSize);
  // Live cols×rows for the status line. Updated in the same ResizeObserver
  // callback that resizes the PTY so the displayed value never drifts.
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  const shellStateRef = useRef({ tabId, shellState: shell?.shellState });
  const resizeReplayPendingRef = useRef(false);
  useEffect(() => {
    tabIdRef.current = tabId;
  }, [tabId]);
  useEffect(() => {
    fontSizeRef.current = fontSize;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = containerRef.current;
    if (!term || !fit || !host) return;
    applyTerminalUiScale(host, term, fontSize);
    try {
      fit.fit();
    } catch {
      /* ignore transient xterm resize errors */
    }
  }, [fontSize]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!tabId) return; // no tab bound yet — wait for the layout to populate
    const invokeShell = (cmd: string, args: Record<string, unknown>) =>
      isRemoteHostId(hostId)
        ? remoteHostInvoke(hostId, cmd, args)
        : invoke(cmd, args);

    const uiScale = readAppUiScale();
    applyTerminalHostUiScale(containerRef.current, uiScale);
    const term = new XTerm({
      fontSize: terminalFontSizeForUiScale(fontSize, uiScale),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      allowProposedApi: true,
      // Theme + ANSI palette read from `--terminal-*` / `--ansi-*`
      // CSS custom properties on `:root`. observeTerminalTheme below
      // re-applies on `data-theme` attribute changes so switching
      // theme mid-session updates running shells.
      theme: readTerminalTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerRef.current);
    const linkDisposable = registerTerminalUrlLinks(term);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, using canvas fallback:", err);
    }
    if (bootGreeting) term.write(bootGreeting);

    // Keystrokes → shell_input. Send the raw bytes the shell wants to
    // see — xterm gives us the pre-encoded sequence (e.g. "\x1b[A" for up
    // arrow), so we forward verbatim.
    const onDataDisposable = term.onData((data) => {
      void invokeShell("shell_input", { tabId: tabIdRef.current, data }).catch(
        () => {
          /* PTY closed mid-keystroke — drop silently */
        },
      );
    });

    // Resize: FitAddon recomputes cols/rows on layout changes; tell the
    // PTY too so child processes (vim, less, …) reflow correctly. Mirror
    // the same dims into local state so the status line displays them
    // without a separate poll loop. See `decideShellResize` for the two
    // guards that keep panel-toggle from raising spurious SIGWINCHes.
    const lastSentDimsRef = { current: null as ShellDims | null };
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let scaleSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let ptyResizeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingPtyResize: ShellDims | null = null;
    const sendPtyResize = (dims: ShellDims) => {
      const decision = decideShellResize(dims, lastSentDimsRef.current);
      if (!decision) return;
      lastSentDimsRef.current = decision;
      void invokeShell("shell_resize", {
        tabId: tabIdRef.current,
        cols: decision.cols,
        rows: decision.rows,
      }).catch(() => {
        /* PTY closed — drop */
      });
    };
    const flushPtyResize = () => {
      ptyResizeTimer = null;
      const dims = pendingPtyResize;
      pendingPtyResize = null;
      if (dims) sendPtyResize(dims);
    };
    const schedulePtyResize = (dims: ShellDims, isUserResizing: boolean) => {
      if (!isUserResizing) {
        if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
        ptyResizeTimer = null;
        pendingPtyResize = null;
        sendPtyResize(dims);
        return;
      }
      pendingPtyResize = dims;
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
      ptyResizeTimer = setTimeout(
        flushPtyResize,
        TERMINAL_PTY_RESIZE_SETTLE_MS,
      );
    };
    const resizeToContainer = () => {
      resizeTimer = null;
      try {
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        const decision = decideShellResize(
          { cols, rows },
          lastSentDimsRef.current,
        );
        if (!decision) return;
        setDims((prev) =>
          prev && prev.cols === decision.cols && prev.rows === decision.rows
            ? prev
            : decision,
        );
        schedulePtyResize(
          decision,
          document.body.classList.contains("ae-resizing-terminal"),
        );
      } catch {
        /* fit transient errors during teardown */
      }
    };
    const syncUiScaleAndResize = (scale = readAppUiScale()) => {
      if (!containerRef.current) return;
      applyTerminalUiScale(
        containerRef.current,
        term,
        fontSizeRef.current,
        scale,
      );
      resizeToContainer();
      if (scaleSettleTimer) clearTimeout(scaleSettleTimer);
      scaleSettleTimer = window.setTimeout(() => {
        scaleSettleTimer = null;
        resizeToContainer();
      }, TERMINAL_UI_SCALE_SETTLE_MS);
    };
    syncUiScaleAndResize(uiScale);
    const ro = new ResizeObserver((entries) => {
      if (shouldSkipResize(entries[0], containerRef.current)) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(
        resizeToContainer,
        terminalFitDelay(
          document.body.classList.contains("ae-resizing-terminal"),
        ),
      );
    });
    ro.observe(containerRef.current);
    const stopThemeObserver = observeTerminalTheme(term);
    const stopScaleObserver = observeTerminalUiScale(syncUiScaleAndResize);

    // PTY chunks land via per-tab CustomEvent (`aethon:shell-output:<tabId>`).
    // App.tsx dispatches them; we route to xterm.write here.
    const onShellOutput = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.length > 0) {
        term.write(detail);
      }
    };
    const eventName = `aethon:shell-output:${tabId}`;
    window.addEventListener(eventName, onShellOutput);

    // Replay any already-buffered scrollback (when the tab was mounted
    // after some output had already streamed). App.tsx writes buffer to
    // /tabs/<idx>/terminalBuffer; we read it via state.
    const tabs =
      (state["tabs"] as
        | Array<{ id: string; terminalBuffer?: string }>
        | undefined) ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.terminalBuffer) term.write(tab.terminalBuffer);

    return () => {
      window.removeEventListener(eventName, onShellOutput);
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (scaleSettleTimer) clearTimeout(scaleSettleTimer);
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
      stopThemeObserver();
      stopScaleObserver();
      onDataDisposable.dispose();
      linkDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once per tabId — switching tabs creates a new instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, tabId]);

  useEffect(() => {
    const previous = shellStateRef.current;
    const sameTab = previous.tabId === tabId;
    resizeReplayPendingRef.current =
      sameTab &&
      previous.shellState !== "running" &&
      shell?.shellState === "running";
    shellStateRef.current = { tabId, shellState: shell?.shellState };
  }, [shell?.shellState, tabId]);

  useEffect(() => {
    if (
      shell?.shellState !== "running" ||
      !tabId ||
      !dims ||
      !resizeReplayPendingRef.current
    ) {
      return;
    }
    resizeReplayPendingRef.current = false;
    const send = isRemoteHostId(hostId)
      ? remoteHostInvoke(hostId, "shell_resize", {
          tabId,
          cols: dims.cols,
          rows: dims.rows,
        })
      : invoke("shell_resize", {
      tabId,
      cols: dims.cols,
      rows: dims.rows,
        });
    void send.catch(() => {
      /* PTY may have exited between state update and replay */
    });
  }, [dims, hostId, shell?.shellState, tabId]);

  return (
    <div className="ae-shell-canvas-wrap" style={{ gridArea: "canvas" }}>
      <div ref={containerRef} className="ae-shell-canvas-term" />
      <ShellStatusBar
        cwd={shell?.cwd ?? ""}
        command={shell?.command ?? ""}
        shareMode={shell?.shareMode ?? "private"}
        tabId={tabId}
        cols={dims?.cols ?? 0}
        rows={dims?.rows ?? 0}
        state={state}
        onEvent={onEvent}
      />
    </div>
  );
}

// Status line under the shell terminal — cwd · command · share-mode badge ·
// cols×rows. The badge is dispatched through the registry via
// `<RegistryComponent type="share-mode-badge" />` so an extension that
// registered a `share-mode-badge` template via `aethon.registerComponent`
// wins over the default React `ShareModeBadge` (template-first lookup
// for non-primitives). Cycle order + labels live in
// `src/utils/shareMode.ts`.
function ShellStatusBar(props: {
  cwd: string;
  command: string;
  shareMode: ShareMode;
  tabId?: string;
  cols: number;
  rows: number;
  state: Record<string, unknown>;
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  const { cwd, command, shareMode, tabId, cols, rows, state, onEvent } = props;
  const cwdShort = useMemo(() => {
    if (!cwd) return "";
    // Show basename + parent for context (".../aethon" instead of just
    // "aethon"), full path is in the title attribute.
    const parts = cwd.replace(/\/+$/, "").split("/");
    if (parts.length <= 2) return cwd;
    return `…/${parts.slice(-2).join("/")}`;
  }, [cwd]);
  // Live shareMode + tabId pass through componentProps; both the default
  // React badge and any override template see them via component.props.
  const badgeProps = useMemo(() => ({ shareMode, tabId }), [shareMode, tabId]);
  // Adapter: the default React badge fires `cycle-share-mode`, which
  // App.tsx routes from the surrounding shell-canvas. Re-emit through
  // the parent BuiltinComponentProps onEvent so it lands on the
  // shell-canvas channel; inject `tabId` if the badge didn't supply
  // it (the standalone-placement path emits with no data).
  //
  // Returning `true` for `cycle-share-mode` only — every OTHER event
  // type (primitive `click`, `submit`, anything from a custom template
  // with multiple controls) falls through (return false) so the inner
  // renderer dispatches it to the bridge with
  // `templateRootType="share-mode-badge"`. Extension handlers observe
  // those events and drive the cycle (or do whatever else they want).
  // The bridge's `aethon.shells` surface deliberately omits a
  // `setShareMode` — privacy mode flips MUST come from a user gesture
  // routed through here, never from the agent.
  const handleBadgeEvent = useMemo<A2UIEventHandler>(
    () => (_component, eventType, data) => {
      if (eventType !== "cycle-share-mode") return false;
      const payload =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      onEvent("cycle-share-mode", {
        ...payload,
        tabId: payload.tabId ?? tabId,
      });
      return true;
    },
    [onEvent, tabId],
  );
  const dimsLabel = cols && rows ? `${cols}×${rows}` : "—";
  return (
    <div className="ae-shell-status-bar" role="status">
      {cwdShort && (
        <span className="ae-shell-status-cwd" title={cwd}>
          {cwdShort}
        </span>
      )}
      {command && (
        <>
          <span className="ae-shell-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="ae-shell-status-cmd">{command}</span>
        </>
      )}
      <span className="ae-shell-status-sep" aria-hidden="true">
        ·
      </span>
      <RegistryComponent
        type="share-mode-badge"
        state={state}
        onEvent={handleBadgeEvent}
        componentProps={badgeProps}
        tabId={tabId}
      />
      <span className="ae-shell-status-spacer" />
      <span className="ae-shell-status-dims">{dimsLabel}</span>
    </div>
  );
}
