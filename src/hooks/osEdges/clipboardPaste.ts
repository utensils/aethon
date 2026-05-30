import type { MutableRefObject } from "react";
import type { Tab } from "../../types/tab";
import type { NotificationInput } from "../useNotifications";
import { saveClipboardImageAttachment } from "../../utils/imageAttachments";

export interface ClipboardPasteDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  pushNotification: (n: NotificationInput) => string;
}

/** Image paste into the chat composer. Tauri webview surfaces
 *  clipboard images via `event.clipboardData.items`; for each
 *  `image/*` item we persist the bytes to `~/.aethon/pastes/<uuid>.<ext>`
 *  via the `save_paste_image` Tauri command and attach it to the
 *  active agent tab's draft. Files larger than the Rust
 *  32 MiB cap surface as a notification rather than silently dropping.
 *
 *  Target tab is captured at paste time, NOT after the async save
 *  resolves — otherwise pasting in tab A and switching to tab B
 *  before save_paste_image returns would attach the @path token to
 *  whichever agent tab is active later. After save resolves we also
 *  verify the captured tab still exists; if the user closed it during
 *  the async save the tokens are dropped rather than appended to an
 *  unrelated tab. The pasted file remains in ~/.aethon/pastes/ for
 *  manual recovery. */
export function subscribeClipboardPaste(deps: ClipboardPasteDeps): () => void {
  const { stateRef, updateTab, pushNotification } = deps;

  const onClipboardPaste = (e: ClipboardEvent) => {
    const focused = document.activeElement;
    const composer = document.querySelector(".a2ui-chat-input");
    if (!composer || !focused || !composer.contains(focused)) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        imageItems.push(it);
      }
    }
    if (imageItems.length === 0) return;
    e.preventDefault();
    const targetId = stateRef.current.activeTabId as string | undefined;
    if (!targetId) return;
    const targetTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const targetTab = targetTabs.find((t) => t.id === targetId);
    if (!targetTab || targetTab.kind !== "agent") return;
    void Promise.all(
      imageItems.map(async (item) => {
        const file = item.getAsFile();
        if (!file) return null;
        try {
          return await saveClipboardImageAttachment(file);
        } catch (err) {
          pushNotification({
            id: "ae-paste-image-failed",
            title: "Image paste failed",
            message: err instanceof Error ? err.message : String(err),
            kind: "error",
            durationMs: 3000,
          });
          return null;
        }
      }),
    ).then((paths) => {
      const attachments = paths.filter((p): p is NonNullable<typeof p> => !!p);
      if (attachments.length === 0) return;
      const stillExists = (stateRef.current.tabs as Tab[] | undefined)?.some(
        (t) => t.id === targetId,
      );
      if (!stillExists) return;
      updateTab(targetId, (t) => ({
        ...t,
        draftAttachments: [...(t.draftAttachments ?? []), ...attachments],
      }));
    });
  };
  document.addEventListener("paste", onClipboardPaste, true);

  return () => {
    document.removeEventListener("paste", onClipboardPaste, true);
  };
}
