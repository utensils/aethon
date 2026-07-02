import { makeEmptyTab, type ShellMeta, type Tab } from "../../types/tab";
import { invokeForHost, isRemoteHostId } from "../../remoteInvoke";
import type { ShareMode } from "../../utils/shareMode";
import { initialDevshellTerminalBuffer } from "../tabOps/devshellTerminal";
import { cwdForNewTab, projectCwdForNewTab } from "../tabOps/helpers";
import type { BridgeMessageContext, BridgeMessageHandler } from "./types";

/** Bridge proxy for `aethon.shells.{list, read, write}`. Mode changes go
 *  through the status-bar badge (frontend invokes `shell_set_share_mode`
 *  directly), never through the agent surface; otherwise an extension
 *  could flip a private tab into sharing without a user gesture and
 *  bypass the opt-in boundary.
 *
 *  For write: we check share mode here (read-write → overlay confirm;
 *  read-write-trusted → write directly; private/read → refuse), then
 *  invoke the Rust shell_write which gates again as defense-in-depth. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export interface CreatedShell {
  tabId: string;
  cwd: string;
  command: string;
  args: string[];
  shareMode: ShareMode;
  inheritEnv: boolean;
  hostId?: string;
}

function shellOpenPayload(shell: CreatedShell): Record<string, unknown> {
  return {
    tabId: shell.tabId,
    ...(shell.command ? { command: shell.command } : {}),
    ...(shell.args.length > 0 ? { args: shell.args } : {}),
    ...(shell.cwd ? { cwd: shell.cwd } : {}),
    ...(shell.shareMode !== "private" ? { shareMode: shell.shareMode } : {}),
    ...(shell.inheritEnv === false ? { inheritEnv: false } : {}),
  };
}

function shellTabExists(ctx: BridgeMessageContext, tabId: string): boolean {
  const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  return tabs.some((tab) => tab.id === tabId);
}

export function reserveShellTab(
  args: Record<string, unknown>,
  ctx: BridgeMessageContext,
): CreatedShell {
  const tabId = optionalString(args.tabId) ?? crypto.randomUUID();
  if (shellTabExists(ctx, tabId)) {
    throw new Error(`shell tab already exists: ${tabId}`);
  }
  const hostId = ctx.sourceHostId;
  const isRemote = isRemoteHostId(hostId);
  const cwd =
    optionalString(args.cwd) ??
    (isRemote
      ? projectCwdForNewTab(ctx.projectsRef.current, ctx.stateRef.current)
      : cwdForNewTab(ctx.projectsRef.current, ctx.stateRef.current)) ??
    "";
  const command = optionalString(args.command) ?? "";
  const commandArgs = optionalStringArray(args.args) ?? [];
  const shareMode: ShareMode = "private";
  const activate = args.activate === true;
  const inheritEnv = args.inheritEnv !== false;
  const initialTerminalBuffer = cwd && !isRemote
    ? initialDevshellTerminalBuffer(ctx.stateRef.current, cwd)
    : "";

  ctx.setState((prev) => {
    const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
    const label = `Shell ${tabs.filter((t) => t.kind === "shell").length + 1}`;
    const projectId = ctx.projectsRef.current.activeId;
    const shell: ShellMeta = {
      cwd,
      command,
      args: commandArgs,
      shareMode,
      shellState: "starting",
    };
    tabs.push({
      ...makeEmptyTab(tabId, label, projectId, "shell"),
      ...(hostId ? { hostId } : {}),
      terminalBuffer: initialTerminalBuffer,
      shell,
    });
    if (!activate) return { ...prev, tabs };
    const panel =
      (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
    const term = (prev.terminal as { open?: boolean } | undefined) ?? {};
    return {
      ...prev,
      tabs,
      terminalPanel: { ...panel, activeSubId: tabId },
      terminal: { ...term, open: true },
    };
  });

  return { tabId, cwd, command, args: commandArgs, shareMode, inheritEnv, hostId };
}

export function removeReservedShellTab(
  tabId: string,
  ctx: BridgeMessageContext,
): void {
  ctx.setState((prev) => {
    const panel =
      (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
    return {
      ...prev,
      tabs: ((prev.tabs as Tab[] | undefined) ?? []).filter(
        (tab) => tab.id !== tabId,
      ),
      ...(panel.activeSubId === tabId
        ? { terminalPanel: { ...panel, activeSubId: "agent-bash" } }
        : {}),
    };
  });
}

export async function startReservedShell(
  shell: CreatedShell,
  ctx: BridgeMessageContext,
): Promise<CreatedShell> {
  await invokeForHost(shell.hostId, "shell_open", {
    args: shellOpenPayload(shell),
  });
  ctx.setState((prev) => ({
    ...prev,
    tabs: ((prev.tabs as Tab[] | undefined) ?? []).map((tab) =>
      tab.id === shell.tabId && tab.kind === "shell" && tab.shell
        ? {
            ...tab,
            shell: { ...tab.shell, shellState: "running" },
          }
        : tab,
    ),
  }));
  return shell;
}

export async function createShell(
  args: Record<string, unknown>,
  ctx: BridgeMessageContext,
): Promise<CreatedShell> {
  const shell = reserveShellTab(args, ctx);
  try {
    return await startReservedShell(shell, ctx);
  } catch (err) {
    removeReservedShellTab(shell.tabId, ctx);
    throw err;
  }
}

export const handleShellQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;
  const route = async (): Promise<unknown> => {
    if (op === "list") {
      return await invokeForHost(ctx.sourceHostId, "shell_list_shareable");
    }
    if (op === "create") {
      return await createShell(args, ctx);
    }
    if (op === "read") {
      return await invokeForHost(ctx.sourceHostId, "shell_read_scrollback", {
        args,
      });
    }
    if (op === "write") {
      return await ctx.routeShellWrite(args);
    }
    throw new Error(`unknown shell_query op: ${op}`);
  };
  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
