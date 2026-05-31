import { useEffect } from "react";
import type { ChatAttachment } from "../../types/a2ui";
import { ImageAttachmentImage } from "./image-attachment-image";

export function ImageLightbox({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="a2ui-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${attachment.name}`}
    >
      <button
        type="button"
        className="a2ui-image-lightbox-backdrop"
        aria-label="Close image preview"
        onClick={onClose}
      />
      <figure className="a2ui-image-lightbox-figure">
        <ImageAttachmentImage attachment={attachment} alt={attachment.name} />
        <figcaption>{attachment.name}</figcaption>
        <button
          type="button"
          className="a2ui-image-lightbox-close"
          aria-label="Close image preview"
          onClick={onClose}
          autoFocus
        >
          ×
        </button>
      </figure>
    </div>
  );
}
