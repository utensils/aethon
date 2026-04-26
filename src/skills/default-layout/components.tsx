/**
 * Default-layout skill: A2UI components — Sidebar, ChatHistory, StatusBar,
 * Terminal, Layout (CSS-grid), ChatInput, MainCanvas. Bundled with
 * layout.a2ui.json (same directory) and exposed via `index.ts`.
 *
 * The renderer treats these no differently from agent-emitted components —
 * the default workspace UI uses the exact same path skills will use to ship
 * their own components.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import type {
  A2UIComponent,
  BooleanValue,
  ChatMessage,
  NumberValue,
  SidebarSection,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import A2UIRenderer from "../../components/A2UIRenderer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

// ---------------------------------------------------------------------------
// Layout — CSS Grid container with template-areas. Children opt into a region
// by setting their own `area` prop; the layout reads it and wraps the child
// in a div with `grid-area: <area>`.
// ---------------------------------------------------------------------------

export function Layout({
  component,
  state,
  renderChild,
}: BuiltinComponentProps) {
  const props = component.props as {
    columns?: StringValue;
    rows?: StringValue;
    areas?: string[];
    gap?: NumberValue;
  };

  const columns = props.columns ? resolveString(props.columns, state) : "1fr";
  const rows = props.rows ? resolveString(props.rows, state) : "1fr";
  const gap = props.gap ? resolveNumber(props.gap, state) : 0;
  const areas = props.areas ? props.areas.map((row) => `"${row}"`).join(" ") : undefined;

  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: columns,
    gridTemplateRows: rows,
    gridTemplateAreas: areas,
    gap: `${gap}px`,
    height: "100%",
    width: "100%",
    minHeight: 0,
  };

  return (
    <div className="a2ui-layout" style={style}>
      {component.children?.map((child) => {
        const childProps = child.props as
          | { area?: string; visible?: BooleanValue }
          | undefined;
        const area = childProps?.area;
        const visible =
          childProps?.visible === undefined
            ? true
            : resolveBoolean(childProps.visible, state);
        const cellStyle: CSSProperties = {
          gridArea: area,
          minWidth: 0,
          minHeight: 0,
          display: visible ? "flex" : "none",
        };
        return (
          <div key={child.id} className="a2ui-layout-cell" style={cellStyle}>
            {renderChild?.(child)}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — collapsible panel with named sections. Items can be inline arrays
// or bound to state via a $ref.
// ---------------------------------------------------------------------------

export function Sidebar({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    sections?: SidebarSection[];
  };

  const title = props.title ? resolveString(props.title, state) : "";

  const resolveItems = (
    items: SidebarSection["items"],
  ): { id: string; label: string; active?: boolean }[] => {
    if (Array.isArray(items)) return items;
    const resolved = resolvePointer(state, items.$ref);
    return Array.isArray(resolved)
      ? (resolved as { id: string; label: string; active?: boolean }[])
      : [];
  };

  return (
    <aside className="a2ui-sidebar">
      {title && <div className="a2ui-sidebar-title">{title}</div>}
      <div className="a2ui-sidebar-sections">
        {props.sections?.map((section) => {
          const items = resolveItems(section.items);
          return (
            <div key={section.id} className="a2ui-sidebar-section">
              <div className="a2ui-sidebar-section-title">{section.title}</div>
              {items.length === 0 ? (
                <div className="a2ui-sidebar-empty">empty</div>
              ) : (
                <ul className="a2ui-sidebar-list">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className={
                        item.active
                          ? "a2ui-sidebar-item a2ui-sidebar-item-active"
                          : "a2ui-sidebar-item"
                      }
                      onClick={() =>
                        onEvent("select", {
                          sectionId: section.id,
                          itemId: item.id,
                        })
                      }
                    >
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// ChatHistory — scrollable message feed. Messages can be plain text or
// embedded A2UI subtrees (rendered recursively).
// ---------------------------------------------------------------------------

export function ChatHistory({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };

  const listRef = useRef<HTMLDivElement>(null);
  const messages = (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [];
  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "Send a message to start a conversation.";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className="a2ui-chat-history" ref={listRef}>
      {messages.length === 0 ? (
        <div className="a2ui-chat-empty">{emptyHint}</div>
      ) : (
        messages.map((m) => (
          <div key={m.id} className={`a2ui-chat-message ${m.role}`}>
            <span className="a2ui-chat-role">{m.role}</span>
            {m.text && (
              <div className="a2ui-chat-text a2ui-markdown">
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            )}
            {m.a2ui && <A2UIRenderer payload={m.a2ui} state={state} />}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MainCanvas — the slot where agent-emitted A2UI flows in. Renders a chat
// feed (history) plus a live "current canvas" subtree if state.canvas is set.
// ---------------------------------------------------------------------------

export function MainCanvas({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    slot?: string;
    messages?: { $ref: string };
  };

  const messages = props.messages
    ? ((resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [])
    : [];

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in (live as object)
      ? (live as { components: A2UIComponent[] })
      : null;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, liveSubtree]);

  return (
    <main className="a2ui-canvas" ref={listRef}>
      {messages.length === 0 && !liveSubtree && (
        <div className="a2ui-canvas-empty">
          The agent's canvas is empty. Send a message to populate it.
        </div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`a2ui-canvas-message ${m.role}`}>
          <span className="a2ui-canvas-role">{m.role}</span>
          {m.text && (
            <div className="a2ui-canvas-text a2ui-markdown">
              <ReactMarkdown>{m.text}</ReactMarkdown>
            </div>
          )}
          {m.a2ui && <A2UIRenderer payload={m.a2ui} state={state} />}
        </div>
      ))}
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} />
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// ChatInput — single-line composer. Submits via onSubmit event with `{ value }`.
// ---------------------------------------------------------------------------

interface SlashCommandHint {
  name: string;
  description?: string;
  usage?: string;
}

export function ChatInput({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    value?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    onSubmit?: string;
    onChange?: string;
    // Slash command suggestions surfaced in a dropdown when the input
    // starts with `/`. Resolved as raw value (not via resolveString) so
    // the array shape comes through intact when bound by $ref.
    commands?: SlashCommandHint[] | { $ref: string };
  };

  const value = props.value ? resolveString(props.value, state) : "";
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;

  // Resolve the commands list. Supports inline arrays or $ref-bound state.
  const commandsRaw = props.commands;
  const commands: SlashCommandHint[] = useMemo(() => {
    if (!commandsRaw) return [];
    if (Array.isArray(commandsRaw)) return commandsRaw;
    if (typeof commandsRaw === "object" && "$ref" in commandsRaw) {
      const resolved = resolvePointer(state, commandsRaw.$ref);
      return Array.isArray(resolved) ? (resolved as SlashCommandHint[]) : [];
    }
    return [];
  }, [commandsRaw, state]);

  // Tracks the draft value the user pressed Escape on. While the live value
  // matches that snapshot, the picker stays dismissed so Escape doesn't
  // require clearing the input. Editing the draft (any change) re-opens.
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  // Slash autocomplete: show when the input begins with `/` (but not `//`,
  // which is the literal-slash escape) and matches at least one command.
  const slashMatch = useMemo(() => {
    if (disabled) return null;
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    const m = value.match(/^\/([A-Za-z][\w-]*)?$/);
    if (!m) return null;
    const prefix = (m[1] ?? "").toLowerCase();
    const matches = commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
    return matches.length > 0 ? { prefix, matches } : null;
  }, [value, commands, disabled, dismissedDraft]);

  const [highlightIdx, setHighlightIdx] = useState(0);
  // Reset highlight when the visible list changes so the cursor stays inside
  // bounds and on the first suggestion for a new prefix.
  useEffect(() => {
    setHighlightIdx(0);
  }, [slashMatch?.matches.length, slashMatch?.prefix]);

  // The slash menu is portalled to document.body so it can't be clipped by
  // ancestor `overflow: hidden` (the default-layout grid cell uses that to
  // contain chat history scrolling). Track the chat-input rect so we can
  // anchor the menu in fixed coordinates above it.
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!slashMatch || !inputContainerRef.current) {
      setMenuAnchor(null);
      return;
    }
    const update = () => {
      const r = inputContainerRef.current!.getBoundingClientRect();
      setMenuAnchor({
        left: r.left + 16,
        bottom: window.innerHeight - r.top + 4,
        width: r.width - 32,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [slashMatch]);

  const insertCommand = (cmd: SlashCommandHint) => {
    const text = `/${cmd.name} `;
    onEvent("change", { value: text });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onEvent("change", { value: e.target.value });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch) {
      const list = slashMatch.matches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertCommand(list[highlightIdx] ?? list[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Just dismiss the picker — keep the typed text intact. The
        // dismissedDraft snapshot above re-opens the picker as soon as
        // the user edits the draft again.
        setDismissedDraft(value);
        return;
      }
      // Enter behavior with the picker open:
      //   - If the draft already matches a command exactly (`/help`,
      //     `/clear`), submit it. Otherwise the user would have to press
      //     Enter twice — once to "insert" the same text, once to submit.
      //   - Else insert the highlighted suggestion to complete the prefix.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = (e.target as HTMLTextAreaElement).value;
        const exact = list.find(
          (c) => v === `/${c.name}` || v.startsWith(`/${c.name} `),
        );
        if (exact && v.trim().length > 0 && !disabled) {
          onEvent("submit", { value: v });
          return;
        }
        insertCommand(list[highlightIdx] ?? list[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length > 0 && !disabled) {
        onEvent("submit", { value: v });
      }
    }
  };

  const handleClick = () => {
    if (value.trim().length > 0 && !disabled) {
      onEvent("submit", { value });
    }
  };

  const handleStop = () => {
    onEvent("cancel");
  };

  return (
    <div className="a2ui-chat-input" ref={inputContainerRef}>
      {slashMatch && menuAnchor &&
        createPortal(
          <div
            className="a2ui-slash-menu"
            role="listbox"
            style={{
              position: "fixed",
              left: `${menuAnchor.left}px`,
              bottom: `${menuAnchor.bottom}px`,
              width: `${menuAnchor.width}px`,
            }}
          >
            {slashMatch.matches.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === highlightIdx}
                className={
                  i === highlightIdx
                    ? "a2ui-slash-item a2ui-slash-item-active"
                    : "a2ui-slash-item"
                }
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't lose focus
                  // before the insertion fires.
                  e.preventDefault();
                  insertCommand(c);
                }}
                onMouseEnter={() => setHighlightIdx(i)}
              >
                <span className="a2ui-slash-item-name">/{c.name}</span>
                {c.usage && (
                  <span className="a2ui-slash-item-usage"> {c.usage}</span>
                )}
                {c.description && (
                  <span className="a2ui-slash-item-desc"> — {c.description}</span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
      <textarea
        className="a2ui-chat-input-field"
        rows={2}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {disabled ? (
        <button
          type="button"
          className="a2ui-chat-input-send a2ui-chat-input-stop"
          onClick={handleStop}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="a2ui-chat-input-send"
          onClick={handleClick}
          disabled={value.trim().length === 0}
        >
          Send
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBar — three-region status footer (left/center/right).
// ---------------------------------------------------------------------------

export function StatusBar({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
  };

  const left = props.left ? resolveString(props.left, state) : "";
  const center = props.center ? resolveString(props.center, state) : "";
  const right = props.right ? resolveString(props.right, state) : "";

  return (
    <footer className="a2ui-status-bar">
      <span className="a2ui-status-left">{left}</span>
      <span className="a2ui-status-center">{center}</span>
      <span className="a2ui-status-right">{right}</span>
    </footer>
  );
}

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
    // stream (`aethon:terminal` window event). Off by default so skills can
    // mount independent terminals without receiving the agent's bash chatter.
    subscribeToBash?: BooleanValue;
  };

  const fontSize = props.fontSize ? resolveNumber(props.fontSize, state) : 13;
  const cols = props.cols ? resolveNumber(props.cols, state) : undefined;
  const rows = props.rows ? resolveNumber(props.rows, state) : undefined;
  const subscribeToBash = props.subscribeToBash
    ? resolveBoolean(props.subscribeToBash, state)
    : false;
  // Optional prop-driven output. Skills/A2UI payloads can still bind a `$ref`
  // to drive the terminal via state — the diff effect below handles it the
  // same way it used to. The default layout no longer uses this; bash output
  // arrives via the `aethon:terminal` window event instead.
  const output = props.output ? resolveString(props.output, state) : "";

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    const term = new XTerm({
      fontSize,
      cols,
      rows,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0e0e10",
        foreground: "#e8e8ec",
        cursor: "#7c8cff",
      },
      cursorBlink: true,
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

    fit.fit();
    term.write("aethon terminal — xterm.js + WebGL\r\n$ ");

    if (props.onInput) {
      term.onData((data) => onEvent("input", { data }));
    }

    // App.tsx fires this event whenever the agent's bash tool produces
    // output. Writing through xterm directly keeps the bounded scrollback
    // buffer xterm already manages — no parallel growing string in React
    // state. Only this terminal subscribes when subscribeToBash is true,
    // so skills can mount independent terminals without picking up the
    // agent's bash stream.
    let onTerminalEvent: ((e: Event) => void) | null = null;
    if (subscribeToBash) {
      onTerminalEvent = (e: Event) => {
        const detail = (e as CustomEvent<string>).detail;
        if (typeof detail === "string" && detail.length > 0) {
          term.write(detail);
        }
      };
      window.addEventListener("aethon:terminal", onTerminalEvent);
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (onTerminalEvent) {
        window.removeEventListener("aethon:terminal", onTerminalEvent);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once — terminal output flows through the `aethon:terminal` event,
    // not React props, so we don't list `output` as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop-driven write path. When a skill or A2UI payload binds the `output`
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
        <span>Terminal</span>
        <span>xterm.js · WebGL</span>
      </div>
      <div ref={containerRef} className="a2ui-terminal-mount" />
    </div>
  );
}
