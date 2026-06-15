/**
 * Terminal — read-only xterm.js display for the agent's bash output, plus
 * the theme-aware xterm palette helpers shared with the interactive
 * shell tabs.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import type {
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
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
} from "./terminal-helpers";

// ---------------------------------------------------------------------------
// Terminal — xterm.js with WebGL renderer. Falls back to canvas if WebGL
// init fails (which it can on some Linux GPUs / older webviews).
// ---------------------------------------------------------------------------

export function Terminal({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    cols?: NumberValue;
    rows?: NumberValue;
    fontSize?: NumberValue;
    output?: StringValue;
    onInput?: string;
    // Opt-in: when true, this instance subscribes to the agent's bash output
    // stream (`aethon:terminal` window event). Off by default so extensions can
    // mount independent terminals without receiving the agent's bash chatter.
    subscribeToBash?: BooleanValue;
    // Display-only mode: hides the cursor and ignores keystrokes entirely.
    // Aethon ships no PTY backend, so the default terminal panel is a
    // window onto the agent's bash output, not an interactive shell —
    // accepting keystrokes that lead nowhere just confuses users into
    // thinking the panel is broken. Extensions with their own input pipeline
    // can opt out by leaving readOnly unset.
    readOnly?: BooleanValue;
    /** Header label shown above the xterm canvas. Lifted out of inline
     *  JSX so brand/voice can be overridden via $ref. */
    headerLabel?: StringValue;
    /** Boot greeting written into the buffer on mount and on tab replay.
     *  Default reads "Aethon Terminal\r\n$ ". Use "" to skip the prompt. */
    bootGreeting?: StringValue;
  };

  const fontSize = props.fontSize ? resolveNumber(props.fontSize, state) : 13;
  const cols = props.cols ? resolveNumber(props.cols, state) : undefined;
  const rows = props.rows ? resolveNumber(props.rows, state) : undefined;
  const subscribeToBash = props.subscribeToBash
    ? resolveBoolean(props.subscribeToBash, state)
    : false;
  const readOnly = props.readOnly
    ? resolveBoolean(props.readOnly, state)
    : false;
  // Default header explicitly distinguishes this read-only agent-bash
  // panel from the new interactive shell tabs (M6 P1 — Cmd+T). Without
  // the contrast, users see two terminals and assume one is broken.
  const headerLabel = props.headerLabel
    ? resolveString(props.headerLabel, state)
    : "Agent bash · read-only";
  const bootGreeting = props.bootGreeting
    ? resolveString(props.bootGreeting, state)
    : "Agent bash output appears here while the agent runs commands.\r\n" +
      "Press ⌘T for an interactive shell tab.\r\n\r\n";
  // Stash boot greeting in a ref so the mount-once effect (which doesn't
  // depend on `bootGreeting`) writes the right initial buffer even if the
  // prop changes later. Replay also reads from this ref so a $ref-driven
  // greeting stays current across tab switches. Update happens inside an
  // effect so React's strict-mode warning about ref-mutation-during-render
  // stays clean.
  const bootGreetingRef = useRef(bootGreeting);
  useEffect(() => {
    bootGreetingRef.current = bootGreeting;
  }, [bootGreeting]);
  // Optional prop-driven output. Extensions/A2UI payloads can still bind a `$ref`
  // to drive the terminal via state — the diff effect below handles it the
  // same way it used to. The default layout no longer uses this; bash output
  // arrives via the `aethon:terminal` window event instead.
  const output = props.output ? resolveString(props.output, state) : "";

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef<string>("");
  const fontSizeRef = useRef(fontSize);

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
    if (termRef.current) return;

    const baseTheme = readTerminalTheme();
    const uiScale = readAppUiScale();
    applyTerminalHostUiScale(containerRef.current, uiScale);
    // xterm.js validates `cols`/`rows` as soon as they appear in the
    // options object — passing `cols: undefined` triggers
    // "cols must be numeric, value: undefined". Build the option bag
    // dynamically so only defined dimensions reach the constructor.
    const term = new XTerm({
      fontSize: terminalFontSizeForUiScale(fontSize, uiScale),
      ...(typeof cols === "number" ? { cols } : {}),
      ...(typeof rows === "number" ? { rows } : {}),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: readOnly
        ? // Hide the cursor in read-only mode by drawing it the same colour
          // as the background — xterm.js doesn't expose a `cursor.hide` flag.
          { ...baseTheme, cursor: baseTheme.background }
        : baseTheme,
      cursorBlink: !readOnly,
      // disableStdin tells xterm to ignore keystrokes entirely. Without this
      // a focused terminal still calls onData for each keystroke (which we
      // currently dispatch as an a2ui_event with no handler), and any
      // unrelated re-render on the same tick can collapse the panel via
      // the layout's `visible` binding.
      disableStdin: readOnly,
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    term.open(containerRef.current);

    // WebGL renderer — fall back gracefully if context creation fails.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, using canvas fallback:", err);
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let scaleSettleTimer: ReturnType<typeof setTimeout> | null = null;
    const fitToContainer = () => {
      resizeTimer = null;
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    };
    const syncUiScale = (scale = readAppUiScale()) => {
      if (!containerRef.current) return;
      applyTerminalUiScale(
        containerRef.current,
        term,
        fontSizeRef.current,
        scale,
      );
      fitToContainer();
      if (scaleSettleTimer) clearTimeout(scaleSettleTimer);
      scaleSettleTimer = window.setTimeout(() => {
        scaleSettleTimer = null;
        fitToContainer();
      }, TERMINAL_UI_SCALE_SETTLE_MS);
    };

    syncUiScale(uiScale);
    term.write(bootGreetingRef.current);

    // onInput wires xterm's keystroke stream to an A2UI event so a future
    // extension with a real PTY backend can plug in. Skip it in read-only mode
    // to keep the terminal display-only.
    if (props.onInput && !readOnly) {
      term.onData((data) => onEvent("input", { data }));
    }

    // App.tsx fires `aethon:terminal` for live bash output and
    // `aethon:terminal-replay` on tab switch (clear + replay the active
    // tab's buffered scrollback). Only this terminal subscribes when
    // subscribeToBash is true so extensions can mount independent terminals
    // without picking up the agent's bash stream.
    let onTerminalEvent: ((e: Event) => void) | null = null;
    let onReplayEvent: ((e: Event) => void) | null = null;
    if (subscribeToBash) {
      onTerminalEvent = (e: Event) => {
        const detail = (e as CustomEvent<string>).detail;
        if (typeof detail === "string" && detail.length > 0) {
          term.write(detail);
        }
      };
      onReplayEvent = (e: Event) => {
        const detail = (e as CustomEvent<string>).detail;
        // `term.reset()` wipes both the visible viewport AND the
        // scrollback ring; `term.clear()` only scrolls visible lines
        // off the top, leaving the prior buffer reachable via
        // mouse-scroll. Without reset, switching back to agent-bash
        // would stack the boot greeting (from mount) on top of the
        // replayed greeting (from this handler) — visible to the user
        // as a double-banner.
        term.reset();
        term.write(bootGreetingRef.current);
        if (typeof detail === "string" && detail.length > 0) {
          term.write(detail);
        }
      };
      window.addEventListener("aethon:terminal", onTerminalEvent);
      window.addEventListener("aethon:terminal-replay", onReplayEvent);
    }

    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(
        fitToContainer,
        terminalFitDelay(
          document.body.classList.contains("ae-resizing-terminal"),
        ),
      );
    });
    ro.observe(containerRef.current);
    const stopThemeObserver = observeTerminalTheme(term);
    const stopScaleObserver = observeTerminalUiScale(syncUiScale);

    return () => {
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (scaleSettleTimer) clearTimeout(scaleSettleTimer);
      stopThemeObserver();
      stopScaleObserver();
      if (onTerminalEvent) {
        window.removeEventListener("aethon:terminal", onTerminalEvent);
      }
      if (onReplayEvent) {
        window.removeEventListener("aethon:terminal-replay", onReplayEvent);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once — terminal output flows through the `aethon:terminal` event,
    // not React props, so we don't list `output` as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop-driven write path. When an extension or A2UI payload binds the `output`
  // prop to a state $ref, write deltas to xterm. Append-only diff: when the
  // new value starts with the previous one, write the suffix; otherwise
  // write the full string (treats it as a reset).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!output || output === lastOutputRef.current) return;
    const delta = output.startsWith(lastOutputRef.current)
      ? output.slice(lastOutputRef.current.length)
      : output;
    term.write(delta);
    lastOutputRef.current = output;
  }, [output]);

  return (
    <div className="a2ui-terminal">
      <div className="a2ui-terminal-header">
        <span>{headerLabel}</span>
      </div>
      <div ref={containerRef} className="a2ui-terminal-mount" />
    </div>
  );
}
