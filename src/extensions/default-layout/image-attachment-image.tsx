import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    if (attachment.previewUrl) return;
    let cancelled = false;
    void invoke<string>("read_paste_image_base64", { path: attachment.path })
      .then((base64) => {
        if (cancelled) return;
        setPasteResult({
          key: cacheKey,
          src: `data:${attachment.mimeType};base64,${base64}`,
        });
      })
      .catch(() => {
        if (!cancelled) setPasteResult({ key: cacheKey, src: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.mimeType, attachment.path, attachment.previewUrl, cacheKey]);

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
