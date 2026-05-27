import systemPromptSource from "../agent/system-prompt/prompt-template.ts?raw";

function extractDefaultPrompt(source: string): string {
  const marker = "export const DEFAULT_AETHON_PROMPT = `";
  const start = source.indexOf(marker);
  if (start === -1) return "";
  let escaped = false;
  let out = "";
  for (let i = start + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      out += ch === "`" || ch === "$" ? ch : `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") return out.trimEnd();
    out += ch;
  }
  return out.trimEnd();
}

export const DEFAULT_AETHON_SYSTEM_PROMPT = extractDefaultPrompt(
  systemPromptSource,
);

export function buildEditableSystemPromptBaseline(): string {
  const base = DEFAULT_AETHON_SYSTEM_PROMPT.trim();
  const note = [
    "<!--",
    "This file is a full override for Aethon's base system prompt.",
    "The live runtime snapshot and system-prompt-append.md are appended",
    "automatically by the bridge, so they are intentionally not copied",
    "here as stale editable text.",
    "-->",
  ].join("\n");
  return `${base}\n\n${note}\n`;
}
