/**
 * Prompt contract for the voice-brain session.
 *
 * The brain shares the app's resource loader (so it gets the standard system
 * prompt + working context); this preamble rides the first prompt of the
 * session — the same pattern subagent `systemPrompt` bodies use
 * (`composeSubagentPrompt` in subagents/task-params.ts). Everything it says
 * exists to keep replies SPEAKABLE: short plain prose that a TTS engine can
 * read without listing file paths or tool output.
 */

import type { VoiceTaskEventMessage, VoiceTurnContext } from "./protocol";

export const VOICE_BRAIN_PREAMBLE = `You are Aethon's voice assistant. Everything you write is spoken aloud to the user through text-to-speech, so:
- Reply in one to three short conversational sentences of plain prose.
- Never use markdown, lists, headings, code, file paths, URLs, or emoji.
- Say names and identifiers in a speech-friendly way ("the config helper" — not a path).
- Do not narrate these rules or mention that you are a voice interface.

You do not do the work yourself — you coordinate a separate work agent:
- When the user asks for work to be done, acknowledge it in one sentence, call the dispatch_task tool with a complete self-contained prompt, then confirm it's underway.
- Never ask the user questions or for permission. If a request is ambiguous, pick the most reasonable interpretation, dispatch it, and say in one sentence what you assumed. When the user says "this directory", "this project", or similar, they mean the active project in the runtime context.
- When a system note tells you a task finished, summarize the outcome and current state in one to three sentences: what was accomplished, whether it succeeded, and what needs the user next. Never read raw output, logs, tool names, or file lists aloud.
- When a system note reports interim progress on a running task, give exactly one short sentence describing what the agent is doing right now, in plain terms.
- When asked about progress, call the check_status tool and answer from its result.
- When the user wants to adjust or add to a task that is already running, call the send_followup tool with the task's label and a complete instruction — do not dispatch a duplicate task.
- For quick questions or chit-chat, just answer — no dispatch needed.`;

function contextBlock(context: VoiceTurnContext): string {
  const lines: string[] = [];
  if (context.projectPath) lines.push(`active project: ${context.projectPath}`);
  if (context.defaultModel) {
    lines.push(`work-agent model: ${context.defaultModel}`);
  }
  if (lines.length === 0) return "";
  return `[runtime context]\n${lines.join("\n")}\n\n`;
}

/** The user's spoken words, prefixed with a compact runtime-context block so
 *  dispatch_task always has real arguments. */
export function buildTurnPrompt(
  text: string,
  context: VoiceTurnContext,
  includePreamble: boolean,
): string {
  const preamble = includePreamble ? `${VOICE_BRAIN_PREAMBLE}\n\n---\n\n` : "";
  return `${preamble}${contextBlock(context)}The user said (via voice): ${text}`;
}

/** System note injected when a dispatched work agent finishes a turn, or —
 *  for `progress` events — while it is still working. */
export function buildTaskEventPrompt(event: VoiceTaskEventMessage): string {
  const label = event.label ? `"${event.label}"` : `in tab ${event.taskTabId}`;
  const report = stripUnspeakable(event.finalText).trim();
  if (event.status === "progress") {
    const body = report
      ? `A digest of its recent activity follows between the markers — source material only, never read it verbatim.\n<activity>\n${report}\n</activity>`
      : "No activity digest is available.";
    return `[system note — not the user speaking] The task ${label} is still working. ${body}\n\nGive the user exactly one short spoken sentence on what it is doing right now. Do not ask anything.`;
  }
  const outcome =
    event.status === "error"
      ? "finished with an error"
      : "finished its current turn";
  const body = report
    ? `Its final report follows between the markers — use it only as source material for a spoken summary, never read it verbatim.\n<report>\n${report}\n</report>`
    : "It produced no text report.";
  return `[system note — not the user speaking] The task ${label} ${outcome}. ${body}\n\nTell the user what happened, following your spoken-reply rules.`;
}

/** Drop fenced code blocks — they are never speakable and just burn brain
 *  context. Inline backticks survive (the model is told not to read them). */
export function stripUnspeakable(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " (code omitted) ");
}
