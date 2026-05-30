import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "../types/a2ui";

export function imageNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || "image";
}

export async function saveClipboardImageAttachment(
  file: File,
): Promise<ChatAttachment> {
  const previewUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : undefined;
  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  const mimeType = file.type || "image/png";
  const ext = mimeType.split("/")[1] || "png";
  const path = await invoke<string>("save_paste_image", {
    bytes,
    extension: ext,
  });
  return {
    id: crypto.randomUUID(),
    kind: "image",
    path,
    name: file.name || imageNameFromPath(path),
    mimeType,
    sizeBytes: file.size,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export function imageAttachmentSrc(attachment: ChatAttachment): string {
  if (attachment.previewUrl) return attachment.previewUrl;
  return convertFileSrc(attachment.path);
}

export function durableImageAttachment(
  attachment: ChatAttachment,
): ChatAttachment {
  const { previewUrl: _previewUrl, ...durable } = attachment;
  return durable;
}

export function durableImageAttachments(
  attachments: ChatAttachment[] | undefined,
): ChatAttachment[] {
  return (attachments ?? []).map(durableImageAttachment);
}
