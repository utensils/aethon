import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "../../types/a2ui";
import { imageAttachmentSrc } from "../../utils/imageAttachments";

export function ImageAttachmentImage({
  attachment,
  alt,
}: {
  attachment: ChatAttachment;
  alt: string;
}) {
  const cacheKey = `${attachment.path}\0${attachment.mimeType}`;
  const fallbackSrc = useMemo(
    () => imageAttachmentSrc(attachment),
    [attachment],
  );
  const [pasteResult, setPasteResult] = useState<{
    key: string;
    src: string | null;
  } | null>(null);
  const src =
    pasteResult?.key === cacheKey && pasteResult.src
      ? pasteResult.src
      : fallbackSrc;
  const attemptedPasteRead = pasteResult?.key === cacheKey;

  const loadPasteFallback = () => {
    if (attemptedPasteRead) return;
    void invoke<string>("read_paste_image_base64", { path: attachment.path })
      .then((base64) =>
        setPasteResult({
          key: cacheKey,
          src: `data:${attachment.mimeType};base64,${base64}`,
        }),
      )
      .catch(() => {
        setPasteResult({ key: cacheKey, src: null });
      });
  };

  return <img src={src} alt={alt} onError={loadPasteFallback} />;
}
