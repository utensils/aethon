import type { DevshellEntry } from "../../../hooks/useDevshell";
import { resolvePointer } from "../../../utils/jsonPointer";

export function resolveDevshellSlice(
  state: unknown,
):
  | { activeRoot?: string | null; entries?: Record<string, DevshellEntry> }
  | undefined {
  try {
    return resolvePointer(state as Record<string, unknown>, "/devshell") as {
      activeRoot?: string | null;
      entries?: Record<string, DevshellEntry>;
    };
  } catch {
    return undefined;
  }
}
