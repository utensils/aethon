import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AethonAgentState } from "./state";
import { setSessionLabelForTab } from "./session-label";
import { SESSION_TITLE_TOOL_NAME } from "./silent-tools";

interface SessionTitleDeps {
  send: (obj: Record<string, unknown>) => void;
}

const SetSessionTabTitleParams = Type.Object({
  title: Type.String({
    description:
      "Brief descriptive title for this session tab, usually 2-5 words.",
  }),
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

export function buildSessionTitleTools(
  state: AethonAgentState,
  deps: SessionTitleDeps,
  tabId: string,
): ToolDefinition[] {
  const setTitleTool = defineTool({
    name: SESSION_TITLE_TOOL_NAME,
    label: "Set session tab title",
    description:
      "Silently rename the current Aethon session tab. Use this as the first step for a new user request; choose a short, descriptive title based on the prompt.",
    promptSnippet:
      "setSessionTabTitle: silently set the current Aethon tab title",
    parameters: SetSessionTabTitleParams,
    async execute(_callId: string, params: SetSessionTabTitleParamsT) {
      const tab = state.tabs.get(tabId);
      const result = await setSessionLabelForTab(
        state,
        deps,
        tabId,
        params.title,
        {
          requireNonEmpty: true,
          syncPiSessionName: (label) => tab?.session.setSessionName(label),
        },
      );
      return asJson({ ok: true, title: result.label });
    },
  }) as ToolDefinition;

  return [setTitleTool];
}
