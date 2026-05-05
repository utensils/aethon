import type { BridgeMessageHandler } from "./types";

/** Generic feedback channel — abstract on purpose so layouts /
 *  extensions can decide how (or whether) to surface it.
 *
 *  Default behavior in default-layout: dispatch a cancellable
 *  `aethon:extension-lifecycle` CustomEvent on window, then (if not
 *  preventDefault'd) append a system-notice chat bubble. A custom layout
 *  can listen on the event and call `e.preventDefault()` to swap a
 *  toast / sidebar pulse / status pill for the default chat-bubble — no
 *  source patches required. */
export const handleExtensionLifecycle: BridgeMessageHandler = (data, ctx) => {
  const detail = {
    name: (data.name as string) ?? "(unknown)",
    source: (data.source as string) ?? "directory",
    status:
      (data.status as
        | "loaded"
        | "failed"
        | "skipped"
        | "disabled"
        | "enabled") ?? "loaded",
    error: data.error as string | undefined,
    path: data.path as string | undefined,
  };
  const tabId = (data.tabId as string | undefined) ?? "default";
  const ev = new CustomEvent("aethon:extension-lifecycle", {
    detail,
    cancelable: true,
  });
  const proceed = window.dispatchEvent(ev);
  if (proceed) {
    // Default rendering — terse one-liner the user can recognize even
    // when the agent's chat reply was eaten by a respawn. Disable /
    // enable toggles also surface here so the user (and the next-turn
    // system prompt, which lists disabledExtensions) have a record.
    const verb =
      detail.status === "loaded"
        ? "loaded"
        : detail.status === "failed"
          ? "failed to load"
          : detail.status === "disabled"
            ? "disabled by user"
            : detail.status === "enabled"
              ? "re-enabled by user"
              : "skipped";
    const suffix = detail.error ? ` — ${detail.error}` : "";
    ctx.appendMessage(
      {
        id: crypto.randomUUID(),
        role: "system",
        text: `Extension \`${detail.name}\` ${verb}${suffix}.`,
      },
      tabId,
    );
  }
};
