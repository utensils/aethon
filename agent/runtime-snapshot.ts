/**
 * Runtime snapshot + state-file persistence.
 *
 * The runtime snapshot describes everything currently loaded — extensions,
 * themes, components, the active layout, tabs, the env. It's surfaced to
 * the agent through:
 *
 *   1. `globalThis.aethon.getRuntimeSnapshot()` — direct introspection.
 *   2. `agent/system-prompt.ts` injects it into pi's system prompt on
 *      every resourceLoader.reload(), so the model's first turn knows
 *      what's on screen.
 *   3. The state file at `$AETHON_STATE_FILE`, refreshed on every
 *      mutation so a `cat` works without an introspection round-trip.
 *
 * The file write is debounced 200 ms and overlap-guarded so a burst of
 * registrations doesn't write 5 times in a row.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "./state";
import type { RuntimeSnapshot } from "./system-prompt";
import { logger } from "./logger";
import { summarizeLayout, summarizeLayoutStructure } from "./layout-manager";
import { getSubagentsForCwd } from "./subagents";

const STATE_FILE_DEBOUNCE_MS = 200;

function jsonByteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text ? Buffer.byteLength(text, "utf8") : 0;
  } catch {
    return 0;
  }
}

function modelKey(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
}

/** Build the live runtime snapshot. Cheap; safe to call from the
 *  appendSystemPromptOverride callback on every resourceLoader.reload. */
export function getRuntimeSnapshot(state: AethonAgentState): RuntimeSnapshot {
  return {
    release: state.releaseMode,
    cwd: process.cwd(),
    docsDir: state.docsDir,
    projectRoot: state.projectRoot,
    userDir: state.userDir,
    stateFile: state.stateFile,
    extensions: [...state.loadedExtensions.entries()].map(([name, source]) => ({
      name,
      source,
      ...(source === "project-directory"
        ? { projectRoot: state.projectExtensionRoots.get(name) }
        : {}),
    })),
    failedExtensions: [...state.loadFailures.entries()].map(([name, info]) => ({
      name,
      source: info.source,
      status: info.status,
      error: info.error,
      ...(info.path ? { path: info.path } : {}),
      ...(info.projectRoot ? { projectRoot: info.projectRoot } : {}),
    })),
    disabledExtensions: [...state.disabledExtensions].sort(),
    themes: [...state.extensionThemes.values()].map((t) => ({
      id: t.id,
      label: t.label,
    })),
    // Introspection / state-file view of the active project's subagents (the
    // prompt advertisement is injected per-turn per-tab-cwd, see system-prompt).
    subagents: [
      ...getSubagentsForCwd(state, state.currentProjectCwd).byName.values(),
    ].map((s) => ({
      name: s.name,
      description: s.description,
      ...(s.model ? { model: s.model } : {}),
      surface: s.surface,
    })),
    components: [...state.extensionComponents.keys()],
    layoutSummary: summarizeLayout(state),
    tabs: [...state.tabs.values()].map((t) => ({
      id: t.id,
      model: t.session.model ? modelKey(t.session.model) : "",
      messageCount: t.session.messages?.length ?? 0,
      ...(state.tabProjectCwds.has(t.id)
        ? { cwd: state.tabProjectCwds.get(t.id) }
        : {}),
    })),
    eventHandlers: state.a2uiEventHandlers.map(({ match }) => ({
      ...(match.templateRootType
        ? { templateRootType: match.templateRootType }
        : {}),
      ...(match.componentType ? { componentType: match.componentType } : {}),
      ...(match.descendantId ? { descendantId: match.descendantId } : {}),
      ...(match.eventType ? { eventType: match.eventType } : {}),
      ...(match.surfaceId ? { surfaceId: match.surfaceId } : {}),
      ...(match.windowId ? { windowId: match.windowId } : {}),
    })),
    nativeWindows: [...state.nativeWindows.values()],
    slashCommands: [...state.extensionSlashCommands.values()],
    piSlashCommands: state.piSlashCommands,
    piSkills: state.piSkills,
    keybindings: [...state.extensionKeybindings.values()],
    menuItems: [...state.extensionMenuItems.values()],
    eventRoutes: [...state.extensionEventRoutes.values()],
    eventRoutingMode: state.eventRoutingMode,
    uiState: Object.fromEntries(state.frontendState),
    layoutStructure: summarizeLayoutStructure(state),
    layoutSlots: state.layoutSlotsCatalogue
      ? {
          version: state.layoutSlotsCatalogue.version,
          slots: state.layoutSlotsCatalogue.slots,
        }
      : null,
    layouts: [...state.extensionLayouts.values()].map((l) => ({
      id: l.id,
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
    })),
    frontendModules: [...state.extensionFrontendModules.values()].map((m) => ({
      name: m.name,
      entryPath: m.entryPath,
      bytes: m.code.length,
    })),
    highlightGrammars: [...state.extensionHighlightGrammars.values()].map(
      (g) => ({
        lang: g.lang,
        bytes: jsonByteLength(g.grammar),
      }),
    ),
  };
}

/** Schedule a debounced write of the snapshot to `state.stateFile`. */
export function scheduleStateFileWrite(state: AethonAgentState): void {
  state.stateFileDirty = true;
  if (state.stateFileTimer) return;
  state.stateFileTimer = setTimeout(async () => {
    state.stateFileTimer = null;
    while (state.stateFileDirty) {
      state.stateFileDirty = false;
      if (state.stateFileWriting) return; // overlap guard
      state.stateFileWriting = true;
      try {
        mkdirSync(state.userDir, { recursive: true });
        await writeFile(
          state.stateFile,
          JSON.stringify(getRuntimeSnapshot(state), null, 2),
        );
      } catch (err) {
        logger
          .scope("state")
          .warn(`write ${state.stateFile}: ${(err as Error).message}`);
      } finally {
        state.stateFileWriting = false;
      }
    }
  }, STATE_FILE_DEBOUNCE_MS);
}
