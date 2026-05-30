import type { A2UIPayload, ChatAttachment, ChatMessage } from "../types/a2ui";

// Persisted-history budget per message text. The in-memory message keeps
// the full string; only the persisted snapshot is trimmed so localStorage
// doesn't blow past quota.
export const MAX_TEXT_BYTES = 8 * 1024;

// Replace `image` component data URLs with a placeholder so persisted history
// doesn't blow past the localStorage quota. The in-memory message keeps the
// full data URL — only the persisted copy is slimmed.
export function stripImageDataUrls(component: unknown): unknown {
  if (!component || typeof component !== "object") return component;
  const c = component as {
    type?: string;
    props?: Record<string, unknown>;
    children?: unknown[];
  };
  let next = c;
  if (
    c.type === "image" &&
    typeof c.props?.src === "string" &&
    c.props.src.startsWith("data:")
  ) {
    next = { ...c, props: { ...c.props, src: "", caption: "[image dropped from history]" } };
  }
  if (Array.isArray(c.children) && c.children.length > 0) {
    next = { ...next, children: c.children.map(stripImageDataUrls) };
  }
  return next;
}

export function trimMessage(m: ChatMessage): ChatMessage {
  let out = m;
  if (m.text && m.text.length > MAX_TEXT_BYTES) {
    out = { ...out, text: m.text.slice(0, MAX_TEXT_BYTES - 1) + "…" };
  }
  if (m.a2ui && Array.isArray(m.a2ui.components)) {
    out = {
      ...out,
      a2ui: { ...m.a2ui, components: m.a2ui.components.map(stripImageDataUrls) as never },
    };
  }
  return out;
}

function normalizedText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function toolResultTexts(message: ChatMessage): string[] {
  const components = message.a2ui?.components ?? [];
  const texts: string[] = [];
  for (const component of components) {
    if (component.type !== "tool-card") continue;
    for (const child of component.children ?? []) {
      if (child.type !== "code") continue;
      const content = child.props?.content;
      if (typeof content === "string" && content.trim().length > 0) {
        texts.push(normalizedText(content));
      }
    }
  }
  return texts;
}

export function dedupeToolResultTextMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const toolOutputs = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const outputs = toolResultTexts(message);
    if (outputs.length > 0) {
      for (const output of outputs) toolOutputs.add(output);
      out.push(message);
      continue;
    }
    const text =
      message.role === "agent" && message.text
        ? normalizedText(message.text)
        : "";
    if (text && toolOutputs.has(text)) continue;
    out.push(message);
  }
  return out;
}

function coerceChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.kind !== "image" ||
      typeof record.path !== "string" ||
      typeof record.name !== "string" ||
      typeof record.mimeType !== "string" ||
      !record.mimeType.startsWith("image/") ||
      typeof record.sizeBytes !== "number" ||
      !Number.isFinite(record.sizeBytes)
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        kind: "image",
        path: record.path,
        name: record.name,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
      },
    ];
  });
}

export function coerceChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role =
      record.role === "user" ||
      record.role === "agent" ||
      record.role === "system"
        ? record.role
        : null;
    if (!role) continue;
    const text = typeof record.text === "string" ? record.text : undefined;
    const thinking =
      typeof record.thinking === "string" ? record.thinking : undefined;
    const a2ui =
      record.a2ui &&
      typeof record.a2ui === "object" &&
      Array.isArray((record.a2ui as { components?: unknown }).components)
        ? (record.a2ui as A2UIPayload)
        : undefined;
    const delivery =
      record.delivery === "sent" ||
      record.delivery === "queued" ||
      record.delivery === "steered" ||
      record.delivery === "failed"
        ? record.delivery
        : undefined;
    const attachments = coerceChatAttachments(record.attachments);
    if (!text && !thinking && !a2ui && attachments.length === 0) continue;
    messages.push(
      trimMessage({
        id:
          typeof record.id === "string" && record.id.length > 0
            ? record.id
            : crypto.randomUUID(),
        role,
        ...(text ? { text } : {}),
        ...(thinking ? { thinking } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(a2ui ? { a2ui } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    );
  }
  return messages;
}
