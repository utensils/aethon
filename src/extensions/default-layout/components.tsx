/* eslint-disable react-refresh/only-export-components -- barrel re-export module; HMR is driven by the sibling source files */

/**
 * Default-layout extension: A2UI components — barrel re-exports.
 *
 * The composites live in focused sibling modules so each family can be
 * understood and edited in isolation:
 *
 *   - `markdown-adapter.tsx` — react-markdown adapter + fenced-code splitter
 *   - `layout.tsx`           — Layout grid, AeMark monogram, scale helper,
 *                               StatusBar + EmptyState chrome
 *   - `sidebar/`             — Sidebar + searchable section + item row
 *   - `chat*.tsx`            — chat history/canvas, composer, slash picker,
 *                               queue popover, ToolCard, formatToolDuration
 *   - `terminal.tsx`         — read-only agent-bash xterm display + theme
 *                               helpers shared with the shell composites
 *   - `shell/`               — ShellCanvas, TerminalPanel, TabStrip
 *
 * The renderer treats these no differently from agent-emitted components —
 * the default workspace UI uses the exact same path extensions will use to ship
 * their own components.
 */

export { MARKDOWN_COMPONENTS, HighlightedFence, isHighlightedFenceChild } from "./markdown-adapter";
export {
  AeMarkInline,
  EmptyState,
  WorktreeLanding,
  Layout,
  StatusBar,
  readUiScale,
} from "./layout";
export { Sidebar, filterItems, providerOf } from "./sidebar";
export { FileTreePanel } from "./sidebar/file-tree";
export {
  ChatHistory,
  ChatInput,
  MainCanvas,
  QueuedMessagesPopover,
  ToolCard,
  formatToolDuration,
} from "./chat";
export { Terminal } from "./terminal";
export { observeTerminalTheme, readTerminalTheme } from "./terminal-helpers";
export { ShellCanvas, TabStrip, TerminalPanel } from "./shell";
export { EditorCanvas, ImageViewer, MarkdownPreview } from "./editor";
export { AuthProfilePanel } from "./auth-profile-panel";
