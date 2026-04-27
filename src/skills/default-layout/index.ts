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
import {
  AeMark,
  AgentStatusPill,
  CanvasOrnament,
  CommandBar,
  EditorialHeader,
  EditorialSpine,
  InspectorPane,
  LayoutChangePill,
  LayoutToast,
  VerticalTabRail,
} from "./variation-components";
import workstationPayload from "./workstation.a2ui.json";
import editorialPayload from "./editorial.a2ui.json";
import commandDeckPayload from "./command-deck.a2ui.json";
import liveLayoutPayload from "./live-layout.a2ui.json";

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
    // Layout-variation chrome — used by editorial / command-deck / live-layout.
    // Registered alongside the standard composites so any layout payload can
    // mix and match them.
    //
    // Canonical names match the design handoff
    // (`aethon-handoff/handoff/component-contracts.md`); legacy aliases
    // (`agent-status-pill`, `editorial-spine`, `canvas-ornament`,
    // `layout-toast`) stay registered so existing layout payloads continue
    // to render after the rename.
    "agent-pulse": AgentStatusPill,
    "agent-status-pill": AgentStatusPill,
    "brand-spine": EditorialSpine,
    "editorial-spine": EditorialSpine,
    "editorial-header": EditorialHeader,
    "ae-ornament": CanvasOrnament,
    "canvas-ornament": CanvasOrnament,
    "ae-mark": AeMark,
    "command-bar": CommandBar,
    "vertical-tab-rail": VerticalTabRail,
    "inspector-pane": InspectorPane,
    "layout-change-pill": LayoutChangePill,
    "layout-diff-toast": LayoutToast,
    "layout-toast": LayoutToast,
  },
  layout: workstationPayload,
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
    id: "workstation",
    name: "Workstation",
    description:
      "Tightened IDE-density default — sidebar, header pill, chrome tabs, terminal, composer, status bar.",
    payload: workstationPayload,
  },
  {
    id: "editorial",
    name: "Editorial",
    description:
      "Brand-forward — vertical Æπ spine, Bodoni header with italic π, chapter-style tabs.",
    payload: editorialPayload,
  },
  {
    id: "command-deck",
    name: "Command Deck",
    description:
      "Vertical session rail + persistent ⌘P command bar in the header. Best for many concurrent sessions.",
    payload: commandDeckPayload,
  },
  {
    id: "live-layout",
    name: "Live Layout",
    description:
      "Showcases the agent rearranging its own UI — sidebar + canvas + inspector pane + setLayout toast.",
    payload: liveLayoutPayload,
  },
];
