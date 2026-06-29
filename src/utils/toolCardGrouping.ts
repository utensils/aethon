import type { ChatMessage } from "../types/a2ui";

interface ToolCardMeta {
  isToolCard: boolean;
  isRunning: boolean;
  isError: boolean;
  status?: string;
  title?: string;
  toolName?: string;
  description?: string;
  filePath?: string;
  startedAt?: number;
  endedAt?: number;
  fileChange?: ToolCardFileChange;
  componentId?: string;
}

interface ToolCardMetaCacheEntry {
  signature: string;
  meta: ToolCardMeta;
}

const toolCardMetaCache = new WeakMap<ChatMessage, ToolCardMetaCacheEntry>();

export interface ToolCardFileChange {
  kind?: "edited" | "created";
  path?: string;
  rootPath?: string;
  preview?: string;
  additions?: number;
  deletions?: number;
}

export interface ToolCardDetails {
  isToolCard: boolean;
  isRunning: boolean;
  isError: boolean;
  status?: string;
  title?: string;
  toolName?: string;
  description?: string;
  filePath?: string;
  startedAt?: number;
  endedAt?: number;
  fileChange?: ToolCardFileChange;
  componentId?: string;
}

export interface ToolMessageSummary {
  total: number;
  running: number;
  failed: number;
  cancelled: number;
  durationMs: number;
  names: string[];
  fileChanges: {
    total: number;
    created: number;
    edited: number;
    additions: number;
    deletions: number;
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFileChange(value: unknown): ToolCardFileChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const path = stringValue(raw.path);
  if (!path) return undefined;
  const kind = raw.kind === "created" ? "created" : "edited";
  const rootPath = stringValue(raw.rootPath);
  const preview = stringValue(raw.preview);
  const additions = finiteNumber(raw.additions);
  const deletions = finiteNumber(raw.deletions);
  return {
    kind,
    path,
    ...(rootPath ? { rootPath } : {}),
    ...(preview ? { preview } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function toolCardMetaSignature(
  componentId: string | undefined,
  props: Record<string, unknown> | undefined,
): string {
  const fileChange =
    props?.fileChange && typeof props.fileChange === "object"
      ? (props.fileChange as Record<string, unknown>)
      : undefined;
  return JSON.stringify([
    componentId ?? "",
    props?.title,
    props?.toolName,
    props?.description,
    props?.filePath,
    props?.status,
    props?.startedAt,
    props?.endedAt,
    props?.isError,
    fileChange?.kind,
    fileChange?.path,
    fileChange?.rootPath,
    fileChange?.preview,
    fileChange?.additions,
    fileChange?.deletions,
  ]);
}

function readToolCardMeta(m: ChatMessage): ToolCardMeta {
  const comp = m.a2ui?.components?.find((c) => c?.type === "tool-card");
  const props = comp?.props;
  const signature = toolCardMetaSignature(comp?.id, props);
  const cached = toolCardMetaCache.get(m);
  if (cached?.signature === signature) return cached.meta;
  const title = stringValue(props?.title);
  const toolName = stringValue(props?.toolName);
  const description = stringValue(props?.description);
  const filePath = stringValue(props?.filePath);
  const status = stringValue(props?.status);
  const startedAt = finiteNumber(props?.startedAt);
  const endedAt = finiteNumber(props?.endedAt);
  const fileChange = readFileChange(props?.fileChange);
  const meta: ToolCardMeta = {
    isToolCard: Boolean(comp),
    isRunning:
      Boolean(props) && startedAt !== undefined && endedAt === undefined,
    isError: props?.isError === true,
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(toolName ? { toolName } : {}),
    ...(description ? { description } : {}),
    ...(filePath ? { filePath } : {}),
    ...(comp?.id ? { componentId: comp.id } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(fileChange ? { fileChange } : {}),
  };
  toolCardMetaCache.set(m, { signature, meta });
  return meta;
}

/** True when a message's A2UI payload is a tool-call card. */
export function isToolCardMessage(m: ChatMessage): boolean {
  return readToolCardMeta(m).isToolCard;
}

/** A tool card that started but hasn't ended is still streaming — keep it
 *  visible (ungrouped) so the user can watch live progress even in a grouped
 *  mode. Mirrors ToolCard's own `running` derivation. */
export function isRunningToolCard(m: ChatMessage): boolean {
  return readToolCardMeta(m).isRunning;
}

/** Title shown on a tool-call card (e.g. "bash", "read"). Cached per
 * message object because grouping and collapsed peeks ask for it repeatedly. */
export function toolCardTitle(m: ChatMessage): string | undefined {
  return readToolCardMeta(m).title;
}

export function toolCardFileChange(
  m: ChatMessage,
): ToolCardFileChange | undefined {
  return readToolCardMeta(m).fileChange;
}

export function toolCardDetails(m: ChatMessage): ToolCardDetails {
  return { ...readToolCardMeta(m) };
}

export function summarizeToolMessages(
  messages: readonly ChatMessage[],
): ToolMessageSummary {
  const names: string[] = [];
  const seenNames = new Set<string>();
  const summary: ToolMessageSummary = {
    total: 0,
    running: 0,
    failed: 0,
    cancelled: 0,
    durationMs: 0,
    names,
    fileChanges: {
      total: 0,
      created: 0,
      edited: 0,
      additions: 0,
      deletions: 0,
    },
  };
  for (const message of messages) {
    const meta = readToolCardMeta(message);
    if (!meta.isToolCard) continue;
    summary.total += 1;
    if (meta.isRunning) summary.running += 1;
    if (meta.isError) summary.failed += 1;
    if (meta.status === "cancelled") summary.cancelled += 1;
    if (meta.startedAt !== undefined && meta.endedAt !== undefined) {
      summary.durationMs += Math.max(0, meta.endedAt - meta.startedAt);
    }
    if (meta.title && !seenNames.has(meta.title)) {
      seenNames.add(meta.title);
      names.push(meta.title);
    }
    if (meta.fileChange) {
      summary.fileChanges.total += 1;
      if (meta.fileChange.kind === "created") summary.fileChanges.created += 1;
      else summary.fileChanges.edited += 1;
      summary.fileChanges.additions += meta.fileChange.additions ?? 0;
      summary.fileChanges.deletions += meta.fileChange.deletions ?? 0;
    }
  }
  return summary;
}
