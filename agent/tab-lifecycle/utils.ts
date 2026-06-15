/**
 * Pure helpers shared by every submodule. None of these touch
 * `AethonAgentState` mutably; they're safe to import from the events,
 * lifecycle, models, and slash-commands modules without circulars.
 */

import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import type { AethonAgentState, ModelDescriptor } from "../state";
import { supportsCodexFastMode } from "../codex-fast-mode";

export interface TabLifecycleDeps {
  send: (obj: Record<string, unknown>) => void;
}

export function modelKey(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
}

export function modelDescriptor(m: Model<Api>): ModelDescriptor {
  const supportedThinkingLevels = getSupportedThinkingLevels(m);
  const thinkingLevels =
    supportedThinkingLevels.length === 1 && supportedThinkingLevels[0] === "off"
      ? []
      : supportedThinkingLevels;
  return {
    id: modelKey(m),
    label: m.name ?? m.id,
    provider: m.provider,
    ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
    ...(supportsCodexFastMode(m) ? { codexFastModeSupported: true } : {}),
  };
}

/** Compile a pi-style enabledModels glob ("anthropic/claude-*") into a
 *  RegExp rooted at the model key. Only `*` is treated as a wildcard
 *  (matches any chars except `/`); everything else is escaped literally. */
export function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWild = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${withWild}$`);
}

/** Sanitize a tabId for use as a directory name on disk. */
export function tabSessionDir(state: AethonAgentState, tabId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(tabId) ? tabId : "_unsafe";
  return join(state.sessionsDir, safe);
}
