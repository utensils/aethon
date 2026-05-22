/* eslint-disable react-refresh/only-export-components -- barrel re-export module; HMR is driven by the sibling source files */

/**
 * Default-layout skill: A2UI components — barrel re-exports.
 *
 * The composites live in focused sibling modules so each family can be
 * understood and edited in isolation:
 *
 *   - `markdown-adapter.tsx` — react-markdown adapter + fenced-code splitter
 *   - `layout.tsx`           — Layout grid, AeMark monogram, scale helper,
 *                               StatusBar + EmptyState chrome
 *   - `sidebar/`             — Sidebar + searchable section + item row
 *   - `chat.tsx`             — ChatHistory, ChatInput, ToolCard, MainCanvas
 *                               (slash palette, formatToolDuration)
 *   - `terminal.tsx`         — read-only agent-bash xterm display + theme
 *                               helpers shared with the shell composites
 *   - `shell/`               — ShellCanvas, TerminalPanel, TabStrip
 *
 * The renderer treats these no differently from agent-emitted components —
 * the default workspace UI uses the exact same path skills will use to ship
 * their own components.
 */

export { MARKDOWN_COMPONENTS, HighlightedFence, isHighlightedFenceChild } from "./markdown-adapter";
export {
  AeMarkInline,
  EmptyState,
  Layout,
  StatusBar,
  readUiScale,
} from "./layout";
export { Sidebar, filterItems, providerOf } from "./sidebar";
export { FileTreePanel } from "./sidebar/file-tree";
export { ChatHistory, ChatInput, MainCanvas, ToolCard, formatToolDuration } from "./chat";
export {
  Terminal,
  observeTerminalTheme,
  readTerminalTheme,
} from "./terminal";
export { ShellCanvas, TabStrip, TerminalPanel } from "./shell";
export { EditorCanvas } from "./editor";
