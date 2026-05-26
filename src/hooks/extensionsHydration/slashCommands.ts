import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildBuiltinSlashCommands,
  type SlashCommand,
} from "../../slashCommands";

export function buildHydratedSlashCommands(
  builtins: SlashCommand[],
  extensionCommands: { name: string; description: string; usage?: string }[],
  piCommands: { name: string; description: string; usage?: string }[],
  makeExtensionCommand: (command: {
    name: string;
    description: string;
    usage?: string;
  }) => SlashCommand,
): SlashCommand[] {
  const builtinNames = new Set(builtins.map((c) => c.name));
  const dispatched = extensionCommands
    .filter((c) => !builtinNames.has(c.name))
    .map(makeExtensionCommand);
  const reservedNames = new Set([
    ...builtins.map((c) => c.name),
    ...dispatched.map((c) => c.name),
  ]);
  const piPassthroughCommands: SlashCommand[] = piCommands
    .filter((s) => !reservedNames.has(s.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      usage: s.usage,
      passthroughToAgent: true,
      run: () => {},
    }));
  return [...builtins, ...dispatched, ...piPassthroughCommands];
}

export interface SlashCommandsDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  piCommandsRef: MutableRefObject<
    { name: string; description: string; usage?: string }[]
  >;
  extensionSlashNamesRef: MutableRefObject<Set<string>>;
}

export function useHydrateSlashCommands(deps: SlashCommandsDeps) {
  const {
    setState,
    stateRef,
    slashCommandsRef,
    piCommandsRef,
    extensionSlashNamesRef,
  } = deps;
  return function hydrateSlashCommands(
    list: { name: string; description: string; usage?: string }[],
    piCommands?: { name: string; description: string; usage?: string }[],
  ) {
    if (piCommands) piCommandsRef.current = piCommands;
    const builtins = buildBuiltinSlashCommands();
    const builtinNames = new Set(builtins.map((b) => b.name));
    const dispatchedNames = list
      .filter((c) => !builtinNames.has(c.name))
      .map((c) => c.name);
    slashCommandsRef.current = buildHydratedSlashCommands(
      builtins,
      list,
      piCommandsRef.current,
      (c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        run: async (args: string) => {
          await invoke("dispatch_a2ui_event", {
            event: JSON.stringify({
              componentId: `slash-command__tpl__${c.name}`,
              componentType: "slash-command",
              templateRootType: "slash-command",
              eventType: "invoke",
              data: { args },
            }),
            tabId: stateRef.current.activeTabId,
          });
        },
      }),
    );
    extensionSlashNamesRef.current = new Set(dispatchedNames);
    setState((prev) => ({
      ...prev,
      slashCommands: slashCommandsRef.current.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        argSource: c.argSource,
      })),
    }));
  };
}
