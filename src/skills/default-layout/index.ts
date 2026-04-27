/**
 * Default-layout skill — bundles the layout components and a default A2UI
 * payload that arranges them. Registered eagerly at app startup so the
 * out-of-the-box workspace UI renders through the same skill plumbing
 * third-party skills will use.
 */

import type { A2UIPayload } from "../../types/a2ui";
import type { A2UISkill } from "../types";
import {
  ChatHistory,
  ChatInput,
  EmptyState,
  Layout,
  MainCanvas,
  Sidebar,
  StatusBar,
  TabStrip,
  Terminal,
} from "./components";
import layoutPayload from "./layout.a2ui.json";
import singlePanePayload from "./single-pane.a2ui.json";
import focusModePayload from "./focus-mode.a2ui.json";

export {
  layoutSlots,
  SLOT_NAMES,
  REQUIRED_SLOT_NAMES,
  isKnownSlot,
  inspectLayoutSlotCoverage,
} from "./slots";
export type {
  LayoutSlotDefinition,
  LayoutSlotCatalogue,
  SlotCoverageReport,
} from "./slots";

export const defaultLayoutSkill: A2UISkill = {
  name: "default-layout",
  components: {
    layout: Layout,
    sidebar: Sidebar,
    "chat-history": ChatHistory,
    "chat-input": ChatInput,
    "status-bar": StatusBar,
    "tab-strip": TabStrip,
    terminal: Terminal,
    "main-canvas": MainCanvas,
    "empty-state": EmptyState,
  },
  layout: layoutPayload,
};

// Built-in layout catalogue. Each entry is a complete A2UI payload the
// user can swap to via `aethon.activateLayout(id)` or `/layout <id>`.
// Extensions can append more via `aethon.registerLayout({id, name, payload})`.
export interface LayoutCatalogueEntry {
  id: string;
  name: string;
  description?: string;
  payload: A2UIPayload;
}

export const builtinLayouts: LayoutCatalogueEntry[] = [
  {
    id: "default",
    name: "Default",
    description: "Sidebar, header, canvas, terminal, chat input, status bar.",
    payload: layoutPayload,
  },
  {
    id: "single-pane",
    name: "Single Pane",
    description: "No sidebar — header + canvas + chat input across full width.",
    payload: singlePanePayload,
  },
  {
    id: "focus-mode",
    name: "Focus Mode",
    description: "Just canvas + chat input + status bar. No sidebar, header, or tabs.",
    payload: focusModePayload,
  },
];
