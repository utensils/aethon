import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AethonAgentState } from "./state";
import { applyBashTimeoutFloor } from "./runtime-config";

type BashToolOptions = Parameters<typeof createBashToolDefinition>[1];
type BashToolExecute = ToolDefinition["execute"];

export function createAethonBashToolDefinition(
  state: AethonAgentState,
  cwd: string,
  options?: BashToolOptions,
): ToolDefinition {
  const base = createBashToolDefinition(cwd, options);
  const baseWithOptionalExecute: { execute?: BashToolExecute } = base;
  const execute = baseWithOptionalExecute.execute?.bind(base);
  if (!execute) return base;
  // Pi's bash schema defines `timeout` in seconds and its local executor
  // multiplies by 1000 internally, so the Aethon floor is seconds too.
  const wrapped: ToolDefinition = {
    ...base,
    execute(callId, args, signal, onUpdate, ctx) {
      return execute(
        callId,
        applyBashTimeoutFloor(
          args as Record<string, unknown>,
          state.bashTimeoutFloorSeconds,
        ),
        signal,
        onUpdate,
        ctx,
      );
    },
  };
  return wrapped;
}
