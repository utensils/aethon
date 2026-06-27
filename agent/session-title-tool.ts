import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AethonAgentState } from "./state";
import { setSessionLabelForTab } from "./session-label";
import {
  normalizeSessionLabel,
  readSessionLabel,
  readSessionLabelMetadata,
} from "./session-history";
import { canonicalCwdForComparison } from "./session-history/lookup";
import { SESSION_TITLE_TOOL_NAME } from "./silent-tools";
import { tabSessionDir } from "./tab-lifecycle/utils";

interface SessionTitleDeps {
  send: (obj: Record<string, unknown>) => void;
}

const SetSessionTabTitleParams = Type.Object({
  title: Type.String({
    description:
      "Brief descriptive title for this session tab, usually 2-5 words.",
  }),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set true only for an explicit user-requested rename or clear task/topic pivot. Normal follow-up prompts should omit this so the first generated title stays stable.",
    }),
  ),
});

type SetSessionTabTitleParamsT = Static<typeof SetSessionTabTitleParams>;

function asJson(value: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
    details: value ?? null,
  };
}

function isPlaceholderSessionTitle(label: string): boolean {
  return ["new chat", "new session", "untitled", "untitled session"].includes(
    label.trim().toLowerCase(),
  );
}

function currentPiSessionName(
  state: AethonAgentState,
  tabId: string,
): string | undefined {
  const manager = state.tabs.get(tabId)?.session.sessionManager as
    | { getSessionName?: () => string | undefined }
    | undefined;
  return manager?.getSessionName?.();
}

async function existingTitleBelongsToCurrentSession(
  state: AethonAgentState,
  tabId: string,
  sessionDir: string,
  existingTitle: string,
): Promise<boolean> {
  if (currentPiSessionName(state, tabId) === existingTitle) return true;

  const currentCwd = state.tabProjectCwds.get(tabId) ?? state.currentProjectCwd;
  if (!currentCwd) return true;
  const metadata = await readSessionLabelMetadata(sessionDir);
  if (!metadata?.cwd) return false;
  const realpathCache = new Map<string, string>();
  return (
    (await canonicalCwdForComparison(metadata.cwd, realpathCache)) ===
    (await canonicalCwdForComparison(currentCwd, realpathCache))
  );
}

export function buildSessionTitleTools(
  state: AethonAgentState,
  deps: SessionTitleDeps,
  tabId: string,
): ToolDefinition[] {
  const setTitleTool = defineTool({
    name: SESSION_TITLE_TOOL_NAME,
    label: "Set session tab title",
    description:
      "Silently title the current Aethon session tab. The first generated title is sticky: later calls preserve an existing non-placeholder title unless force=true is used for an explicit user-requested rename or clear task/topic pivot.",
    promptSnippet:
      "setSessionTabTitle: silently set the current Aethon tab title",
    parameters: SetSessionTabTitleParams,
    async execute(_callId: string, params: SetSessionTabTitleParamsT) {
      const title = normalizeSessionLabel(params.title);
      if (!title) throw new Error("setSessionTabTitle: title required");

      const sessionDir = tabSessionDir(state, tabId);
      const existingTitle = await readSessionLabel(sessionDir);
      if (
        existingTitle &&
        !isPlaceholderSessionTitle(existingTitle) &&
        params.force !== true &&
        (await existingTitleBelongsToCurrentSession(
          state,
          tabId,
          sessionDir,
          existingTitle,
        ))
      ) {
        return asJson({
          ok: true,
          title: existingTitle,
          skipped: "already_named",
        });
      }

      const tab = state.tabs.get(tabId);
      const result = await setSessionLabelForTab(state, deps, tabId, title, {
        requireNonEmpty: true,
        syncPiSessionName: (label) => tab?.session.setSessionName(label),
      });
      return asJson({ ok: true, title: result.label });
    },
  }) as ToolDefinition;

  return [setTitleTool];
}
