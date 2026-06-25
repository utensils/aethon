import { stripExpandedFileReferences } from "../file-references";
import type { Subagent } from "./types";
import type { SubagentToolResult } from "./task-params";

interface TasksApi {
  start(args: {
    projectPath: string;
    prompt: string;
    model?: string;
    bridgePrompt?: string;
    activate?: boolean;
    label?: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

function getTasksApi(): TasksApi | null {
  const g = globalThis as { aethon?: { tasks?: TasksApi } };
  return g.aethon?.tasks ?? null;
}

export async function launchSubagentTab(
  sub: Subagent,
  cwd: string,
  composedPrompt: string,
  options: {
    activate: boolean;
    surface: "tab" | "background";
    label?: string;
  },
): Promise<SubagentToolResult> {
  const api = getTasksApi();
  if (!api)
    throw new Error(
      "subagent tab launch unavailable (aethon.tasks API missing)",
    );
  const displayPrompt = stripExpandedFileReferences(composedPrompt);
  const result = await api.start({
    projectPath: cwd,
    prompt: displayPrompt,
    ...(displayPrompt !== composedPrompt
      ? { bridgePrompt: composedPrompt }
      : {}),
    ...(sub.model ? { model: sub.model } : {}),
    ...(options.activate === false ? { activate: false } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `subagent "${sub.name}" tab launch failed: ${result.error ?? "unknown"}`,
    );
  }
  const surfaceText =
    options.surface === "background" ? "a background tab" : "a new tab";
  return {
    content: [
      {
        type: "text",
        text: `Launched subagent \`${sub.name}\` in ${surfaceText}.`,
      },
    ],
    details: {
      subagent: sub.name,
      model: sub.model ?? "inherited",
      surface: options.surface,
    },
  };
}
