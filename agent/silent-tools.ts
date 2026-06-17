export const SESSION_TITLE_TOOL_NAME = "setSessionTabTitle";

const SILENT_TOOL_NAMES = new Set<string>([SESSION_TITLE_TOOL_NAME]);

export function isSilentTool(toolName: string): boolean {
  return SILENT_TOOL_NAMES.has(toolName);
}
