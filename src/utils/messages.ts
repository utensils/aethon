import type { A2UIPayload, ChatMessage } from "../types/a2ui";

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
    if (!text && !thinking && !a2ui) continue;
    messages.push(
      trimMessage({
        id:
          typeof record.id === "string" && record.id.length > 0
            ? record.id
            : crypto.randomUUID(),
        role,
        ...(text ? { text } : {}),
        ...(thinking ? { thinking } : {}),
        ...(a2ui ? { a2ui } : {}),
      }),
    );
  }
  return messages;
}
