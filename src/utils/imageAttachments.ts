import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "../types/a2ui";

export function imageNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || "image";
}

export async function saveClipboardImageAttachment(
  file: File,
): Promise<ChatAttachment> {
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
  };
}

export function imageAttachmentSrc(attachment: ChatAttachment): string {
  return convertFileSrc(attachment.path);
}
