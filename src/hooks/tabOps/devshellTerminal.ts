import { TERMINAL_REPLAY_MAX } from "./constants";

const PREPARING_MESSAGE =
  "[devshell] Preparing Nix devshell for this workspace...\r\n";

export function initialDevshellTerminalBuffer(
  state: Record<string, unknown>,
  cwd: string,
): string {
  const existing = devshellOutputForCwd(state, cwd);
  if (existing) return existing;
  return devshellNeedsPreparation(state, cwd) ? PREPARING_MESSAGE : "";
}

export function devshellNeedsPreparation(
  state: Record<string, unknown>,
  cwd: string,
): boolean {
  const entry = devshellEntryForCwd(state, cwd);
  if (!entry) return false;
  return entry.state === "idle" || entry.state === "resolving";
}

function devshellOutputForCwd(
  state: Record<string, unknown>,
  cwd: string,
): string {
  const devshell = state.devshell as Record<string, unknown> | undefined;
  const outputByRoot =
    (devshell?.outputByRoot as Record<string, string> | undefined) ?? {};
  let bestRoot = "";
  let bestBuffer = "";
  for (const [root, buffer] of Object.entries(outputByRoot)) {
    if (typeof buffer !== "string") continue;
    if (isUnderRoot(cwd, root) && root.length > bestRoot.length) {
      bestRoot = root;
      bestBuffer = buffer;
    }
  }
  return bestBuffer.length > TERMINAL_REPLAY_MAX
    ? bestBuffer.slice(bestBuffer.length - TERMINAL_REPLAY_MAX)
    : bestBuffer;
}

function devshellEntryForCwd(
  state: Record<string, unknown>,
  cwd: string,
): { state?: string } | null {
  const devshell = state.devshell as Record<string, unknown> | undefined;
  const entries =
    (devshell?.entries as Record<string, { state?: string }> | undefined) ?? {};
  let bestRoot = "";
  let bestEntry: { state?: string } | null = null;
  for (const [root, entry] of Object.entries(entries)) {
    if (isUnderRoot(cwd, root) && root.length > bestRoot.length) {
      bestRoot = root;
      bestEntry = entry;
    }
  }
  return bestEntry;
}

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd.startsWith(prefix);
}
