import { useEffect, useMemo, useState } from "react";
import { resolvePointer } from "../../utils/jsonPointer";

export interface SlashCommandHint {
  name: string;
  description?: string;
  usage?: string;
  argSource?: string;
}

export interface SlashArgChoice {
  value: string;
  label?: string;
  description?: string;
  hint?: string;
}

export type CommandMatch = { kind: "command"; cmd: SlashCommandHint };
export type ArgMatch = {
  kind: "arg";
  cmd: SlashCommandHint;
  choice: SlashArgChoice;
};
export type PickerMatch = CommandMatch | ArgMatch;

export interface SlashMatch {
  mode: "command" | "arg";
  prefix: string;
  matches: PickerMatch[];
  cmd?: SlashCommandHint;
}

export type SlashCommandSource = SlashCommandHint[] | { $ref: string };

export function normalizeArgChoices(raw: unknown): SlashArgChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashArgChoice[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      out.push({ value: r });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const value =
      typeof obj.value === "string"
        ? obj.value
        : typeof obj.id === "string"
          ? obj.id
          : "";
    if (!value) continue;
    out.push({
      value,
      label: typeof obj.label === "string" ? obj.label : undefined,
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      hint: typeof obj.hint === "string" ? obj.hint : undefined,
    });
  }
  return out;
}

export function resolveSlashCommands(
  commandsRaw: SlashCommandSource | undefined,
  state: Record<string, unknown>,
): SlashCommandHint[] {
  if (!commandsRaw) return [];
  if (Array.isArray(commandsRaw)) return commandsRaw;
  if (typeof commandsRaw === "object" && "$ref" in commandsRaw) {
    const resolved = resolvePointer(state, commandsRaw.$ref);
    return Array.isArray(resolved) ? (resolved as SlashCommandHint[]) : [];
  }
  return [];
}

export function matchSlashCommand(
  value: string,
  commands: SlashCommandHint[],
  state: Record<string, unknown>,
): SlashMatch | null {
  const cmdM = value.match(/^\/([A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?)?$/);
  if (cmdM) {
    const prefix = (cmdM[1] ?? "").toLowerCase();
    const matches: PickerMatch[] = commands
      .filter((c) => c.name.toLowerCase().startsWith(prefix))
      .map((cmd) => ({ kind: "command", cmd }));
    return matches.length > 0 ? { mode: "command", prefix, matches } : null;
  }

  const argM = value.match(
    /^\/([A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?) ([^\n]*)$/,
  );
  if (argM) {
    const cmdName = (argM[1] ?? "").toLowerCase();
    const argPrefix = (argM[2] ?? "").toLowerCase();
    const cmd = commands.find((c) => c.name.toLowerCase() === cmdName);
    if (!cmd || !cmd.argSource) return null;
    const raw = resolvePointer(state, cmd.argSource);
    const choices = normalizeArgChoices(raw).filter((ch) => {
      const haystack = `${ch.value} ${ch.label ?? ""}`.toLowerCase();
      return haystack.includes(argPrefix);
    });
    const matches: PickerMatch[] = choices.map((choice) => ({
      kind: "arg",
      cmd,
      choice,
    }));
    return matches.length > 0
      ? { mode: "arg", prefix: argPrefix, matches, cmd }
      : null;
  }

  return null;
}

export function useSlashMatching({
  value,
  commandsRaw,
  state,
}: {
  value: string;
  commandsRaw?: SlashCommandSource;
  state: Record<string, unknown>;
}) {
  const commands = useMemo(
    () => resolveSlashCommands(commandsRaw, state),
    [commandsRaw, state],
  );
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);

  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  const slashMatch = useMemo(() => {
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    return matchSlashCommand(value, commands, state);
  }, [value, commands, state, dismissedDraft]);

  const [highlightIdx, setHighlightIdx] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightIdx(0);
  }, [slashMatch?.matches.length, slashMatch?.prefix, slashMatch?.mode]);

  return {
    commands,
    slashMatch,
    highlightIdx,
    setHighlightIdx,
    dismissPicker: () => setDismissedDraft(value),
  };
}
