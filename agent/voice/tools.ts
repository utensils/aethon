/**
 * The voice brain's two tools. It gets NOTHING else (`noTools: "builtin"`) —
 * the brain coordinates; the work agent works.
 *
 * `dispatch_task` rides the same `aethon.tasks.start` path the dashboard and
 * `task` tool use (frontend `dashboardQuery op:"start_task"`), launching a
 * non-focused work-agent tab. `check_status` answers "how's it going" from
 * the brain's own dispatch registry plus the bridge's live prompt-in-flight
 * view.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { VoiceTurnContext } from "./protocol";

export interface DispatchedTask {
  tabId: string;
  label: string;
  status: "running" | "completed" | "error";
}

interface StartTaskResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface VoiceToolDeps {
  /** `aethon.tasks.start`-shaped launcher (injected for tests). */
  startTask: (input: {
    projectPath: string;
    prompt: string;
    model: string;
    activate: boolean;
    label?: string;
  }) => Promise<StartTaskResult>;
  getContext: () => VoiceTurnContext;
  onDispatched: (task: DispatchedTask) => void;
  listTasks: () => DispatchedTask[];
  /** Count of bridge tabs with a prompt in flight (any origin). */
  countRunningTabs: () => number;
}

const DispatchParams = Type.Object({
  prompt: Type.String({
    description:
      "Complete, self-contained prompt for the work agent. Include everything it needs — it cannot hear the conversation.",
  }),
  label: Type.Optional(
    Type.String({
      description: "Short human-readable label for the task (a few words).",
    }),
  ),
});

function textResult(text: string): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text }] };
}

export function buildVoiceBrainTools(deps: VoiceToolDeps): ToolDefinition[] {
  const dispatchTask = defineTool({
    name: "dispatch_task",
    label: "Dispatch a task to the work agent",
    description:
      "Launch the work agent on a task in the active project. Returns the task's tab id; you will be told when it finishes.",
    parameters: DispatchParams,
    async execute(
      _callId: string,
      params: { prompt: string; label?: string },
    ) {
      const context = deps.getContext();
      if (!context.projectPath) {
        return textResult(
          "Dispatch failed: no active project. Ask the user to open a project first.",
        );
      }
      if (!context.defaultModel) {
        return textResult(
          "Dispatch failed: no work-agent model is configured. Ask the user to pick a model.",
        );
      }
      const label = params.label?.trim() || summarizeAsLabel(params.prompt);
      const result = await deps.startTask({
        projectPath: context.projectPath,
        prompt: params.prompt,
        model: context.defaultModel,
        activate: false,
        label,
      });
      if (!result.ok) {
        return textResult(
          `Dispatch failed: ${result.error ?? "unknown error"}.`,
        );
      }
      const data = (result.data ?? {}) as { tabId?: unknown };
      const tabId = typeof data.tabId === "string" ? data.tabId : "";
      if (!tabId) {
        return textResult(
          "Dispatch reported success but returned no tab id — treat the launch as uncertain.",
        );
      }
      deps.onDispatched({ tabId, label, status: "running" });
      return textResult(
        `Task "${label}" dispatched (tab ${tabId}). You'll be notified when it finishes.`,
      );
    },
  }) as ToolDefinition;

  const checkStatus = defineTool({
    name: "check_status",
    label: "Check task status",
    description:
      "Report the status of tasks you dispatched plus how many agent tabs are currently working.",
    parameters: Type.Object({}),
    // eslint-disable-next-line @typescript-eslint/require-await -- ToolDefinition.execute must be async
    async execute() {
      const tasks = deps.listTasks();
      const running = deps.countRunningTabs();
      const lines = tasks.map(
        (task) => `- "${task.label}" (tab ${task.tabId}): ${task.status}`,
      );
      const summary = lines.length
        ? `Dispatched tasks:\n${lines.join("\n")}`
        : "No tasks have been dispatched in this conversation.";
      return textResult(
        `${summary}\nAgent tabs currently working: ${running}.`,
      );
    },
  }) as ToolDefinition;

  return [dispatchTask, checkStatus];
}

/** First few words of the prompt as a fallback tab label. */
export function summarizeAsLabel(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 47)}…` : words || "voice task";
}
