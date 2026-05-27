/**
 * Pi slash-command discovery + deduplication.
 *
 * Three sources are merged into a single list, in priority order:
 *  1. Extension-registered commands (from pi's private
 *     `session._extensionRunner.getRegisteredCommands()` — TODO: swap
 *     for the public API once exposed).
 *  2. Prompt templates declared on the session.
 *  3. Skills loaded via `state.resourceLoader.getSkills()`, prefixed
 *     with `skill:` so they don't collide with command names.
 *
 * Duplicate names are dropped after the first occurrence so extensions
 * win over skills win over prompts (priority by source order).
 */

import { logger } from "../logger";
import type {
  AethonAgentState,
  RegisteredPiSlashCommand,
  TabRecord,
} from "../state";

function samePiSlashCommands(
  a: RegisteredPiSlashCommand[],
  b: RegisteredPiSlashCommand[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    return (
      left.name === right?.name &&
      left.description === right.description &&
      left.usage === right.usage &&
      left.source === right.source
    );
  });
}

let warnedMissingExtensionRunner = false;

export function collectPiSlashCommands(
  state: AethonAgentState,
  session: TabRecord["session"],
): RegisteredPiSlashCommand[] {
  const seen = new Set<string>();
  const out: RegisteredPiSlashCommand[] = [];
  const push = (cmd: RegisteredPiSlashCommand) => {
    const name = typeof cmd.name === "string" ? cmd.name.trim() : "";
    if (!/^[A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?$/.test(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      description: cmd.description || "",
      ...(cmd.usage ? { usage: cmd.usage } : {}),
      ...(cmd.source ? { source: cmd.source } : {}),
      ...(cmd.sourceInfo ? { sourceInfo: cmd.sourceInfo } : {}),
    });
  };

  const runner = (
    session as {
      _extensionRunner?: {
        getRegisteredCommands?: () => {
          invocationName?: string;
          description?: string;
          sourceInfo?: unknown;
        }[];
      };
    }
  )._extensionRunner;
  if (!runner && !warnedMissingExtensionRunner) {
    warnedMissingExtensionRunner = true;
    logger
      .scope("slash")
      .warn(
        "pi extension command discovery is using a private session API; _extensionRunner is unavailable",
      );
  }
  // TODO: switch extension command discovery to pi's public API once exposed.
  for (const command of runner?.getRegisteredCommands?.() ?? []) {
    push({
      name: command.invocationName ?? "",
      description: command.description ?? "",
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }

  for (const template of session.promptTemplates ?? []) {
    push({
      name: template.name,
      description: template.description ?? "",
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }

  const skills =
    (
      state.resourceLoader as
        | {
            getSkills?: () => {
              skills: {
                name: string;
                description?: string;
                sourceInfo?: unknown;
              }[];
            };
          }
        | undefined
    )?.getSkills?.().skills ?? [];
  for (const skill of skills) {
    push({
      name: `skill:${skill.name}`,
      description: skill.description ?? "",
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }

  return out;
}

export function refreshPiSlashCommands(
  state: AethonAgentState,
  session: TabRecord["session"],
): void {
  const next = collectPiSlashCommands(state, session);
  if (!samePiSlashCommands(state.piSlashCommands, next)) {
    state.piSlashCommands = next;
    state.piSkills = next
      .filter((c) => c.source === "skill" && c.name.startsWith("skill:"))
      .map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.usage ? { usage: c.usage } : {}),
      }));
  }
}
